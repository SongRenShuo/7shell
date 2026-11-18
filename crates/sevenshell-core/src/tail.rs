//! Following a file on the far side, line by line, for as long as a window watches it.
//!
//! The command is a fixed verb — `tail -n <lines> -F -- <path>` — decided by policy before the
//! session is even looked at, the same order every other unattended action takes. The path is a
//! typed value that never becomes part of a classifier's input: it is quoted with the one quoter
//! this build has, so a filename with a space, a quote or a semicolon in it arrives at the far
//! side as one argument and nothing else.
//!
//! The stream is the container log stream's shape, one crate over: a registry of stoppers, a task
//! pumping lines to whoever listens, and an end event after the last line. A stop closes the
//! command's channel, which is what ends `tail` on the far side; the same happens when the
//! connection the tail rides goes away, because the reader sees the channel break and ends with
//! it.

use std::collections::HashMap;
use std::sync::Arc;

use sevenshell_error::ShellError;
use sevenshell_types::{Protocol, TailStreamEnd, TailStreamLine};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc::{self, UnboundedSender};

use crate::Core;
use crate::container::decision_error;
use crate::sessions::ConnectionOutcome;
use crate::shell_quote;

/// The stops for the streams a tail window is following, keyed by the id the host emitted.
pub(crate) type TailStreamStops = HashMap<String, Arc<dyn Fn() + Send + Sync>>;

/// The fewest lines a tail may be asked for. Fewer than this is a typo, not a wish.
const MIN_TAIL_LINES: u32 = 10;

/// The most lines a tail may be asked for, so a slip cannot ask the far side for a megabyte of
/// backlog before the first line lands.
const MAX_TAIL_LINES: u32 = 1000;

/// How much of a read is buffered before lines are looked for. A log line is nowhere near this;
/// even a Java stack trace usually is.
const TAIL_READ_BUFFER_BYTES: usize = 8192;

impl Core {
    /// Follows a file on the far side, sending every line to `events` and the end to `end`, and
    /// answers the id the interface keeps.
    ///
    /// The order is the one every unattended action takes: session, protocol, policy, carrier,
    /// and only then the command. `tail.open` is `Caution` — reading a file runs unattended
    /// under the default rule — and the path travels with the decision as its subject, so the
    /// audit line and any question a stricter installation asks name *which* file.
    pub async fn file_tail_open(
        &self,
        session_id: &str,
        path: &str,
        lines: u32,
        events: UnboundedSender<TailStreamLine>,
        end: UnboundedSender<TailStreamEnd>,
    ) -> Result<String, ShellError> {
        let session = self.session(session_id)?;
        match session.protocol {
            // The workbench session speaks SSH in every mechanical sense, exactly as the terminal
            // open does; a tail needs an exec channel, and only SSH carries one.
            Protocol::Ssh | Protocol::LinuxDesk => {}
            _ => {
                return Err(ShellError::app_unsupported(
                    "a file can be followed only on a session that speaks SSH",
                ));
            }
        }

        let session_target = self.session_policy_target(session_id);
        let target = session_target
            .as_ref()
            .map(|session| session.as_target())
            .unwrap_or_default();
        self.unattended_gate(
            "tail.open",
            &sevenshell_policy::tail_open(),
            target,
            Some(session_id),
            Some(path),
        )?;

        let carrier = match self.open_carrier(&session).await? {
            ConnectionOutcome::Ready(carrier) => carrier,
            ConnectionOutcome::Decision(decision) => return Err(decision_error(*decision)),
        };

        let command = tail_command(lines, path);
        let mut source = carrier.connection.open_exec_stream(&command).await?;

        let tail_id = uuid::Uuid::new_v4().to_string();
        let registry = Arc::clone(&self.tail_streams);
        let (stop_sender, mut stop) = mpsc::channel::<()>(1);
        registry.lock().await.insert(
            tail_id.clone(),
            Arc::new(move || {
                // On a channel of one, the first stop wins and a second finds it full: a stop may
                // be called from anywhere, including a window that is closing.
                let _ = stop_sender.try_send(());
            }),
        );

        let task_id = tail_id.clone();
        tokio::spawn(async move {
            let mut pending = Vec::new();
            let mut buffer = vec![0u8; TAIL_READ_BUFFER_BYTES];
            loop {
                tokio::select! {
                    // Biased, so a stop is not starved by a file that never stops being written.
                    biased;
                    stopped = stop.recv() => {
                        // `None` means the handle that could stop this was dropped, which is the
                        // same wish expressed by going away. Breaking drops the channel, and
                        // dropping the channel is what ends `tail` on the far side.
                        let _ = stopped;
                        break;
                    }
                    read = source.read(&mut buffer) => match read {
                        // The file's end or a channel that broke: both are an end, not a line.
                        Ok(0) | Err(_) => break,
                        Ok(count) => {
                            pending.extend_from_slice(&buffer[..count]);
                            if !emit_lines(&mut pending, &task_id, &events).await {
                                // The watcher went away; the end event has nowhere to go either.
                                break;
                            }
                        }
                    },
                }
            }
            // A last line without a newline is still a line. Dropping it would hide the last word
            // of everything the file said after its final newline.
            if !pending.is_empty() {
                let event = TailStreamLine {
                    tail_id: task_id.clone(),
                    line: String::from_utf8_lossy(&pending).into_owned(),
                };
                let _ = events.send(event);
            }
            registry.lock().await.remove(&task_id);
            let _ = end.send(TailStreamEnd {
                tail_id: task_id,
                error: None,
            });
        });

        Ok(tail_id)
    }

    /// Stops one tail. Asking to stop a tail that is already gone is not a failure: the caller
    /// asked for it to not be there, and it is not.
    pub async fn file_tail_close(&self, tail_id: &str) -> Result<(), ShellError> {
        let stop = self.tail_streams.lock().await.remove(tail_id);
        if let Some(stop) = stop {
            stop();
        }
        Ok(())
    }
}

/// The command a tail runs, with the line count clamped and the path quoted.
///
/// `-F` rather than `-f` because a followed log is rotated underneath the reader: `-F` reopens the
/// name instead of reading a file that will never be written again. `--` closes the option list,
/// so a path that begins with a dash is still a path.
pub(crate) fn tail_command(lines: u32, path: &str) -> String {
    let lines = lines.clamp(MIN_TAIL_LINES, MAX_TAIL_LINES);
    format!("tail -n {lines} -F -- {}", shell_quote(path))
}

/// Emits every complete line the buffer now holds, and answers whether the watcher is still there.
///
/// A line ends at its newline; a carriage return before it is a terminal-style ending and goes
/// with it. What is left after the last newline stays in the buffer for the next read.
async fn emit_lines(pending: &mut Vec<u8>, tail_id: &str, events: &UnboundedSender<TailStreamLine>) -> bool {
    while let Some(position) = pending.iter().position(|&byte| byte == b'\n') {
        let mut line: Vec<u8> = pending.drain(..=position).collect();
        line.pop();
        if line.last() == Some(&b'\r') {
            line.pop();
        }
        let event = TailStreamLine {
            tail_id: tail_id.to_owned(),
            line: String::from_utf8_lossy(&line).into_owned(),
        };
        if events.send(event).is_err() {
            return false;
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex as StdMutex};

    use sevenshell_policy::{PolicyAuditEvent, PolicyJournal};
    use sevenshell_types::{AuthMethod, PolicyAction, PolicyMatrix, PolicyRule, SessionAuth, TerminalSettings};
    use sevenshell_vault::Vault;
    use tempfile::{TempDir, tempdir};
    use tokio::sync::mpsc;

    use super::*;
    use crate::Core;

    #[derive(Default)]
    struct RecordingJournal {
        events: StdMutex<Vec<PolicyAuditEvent>>,
    }

    impl RecordingJournal {
        fn events(&self) -> Vec<PolicyAuditEvent> {
            self.events.lock().expect("not poisoned").clone()
        }
    }

    impl PolicyJournal for RecordingJournal {
        fn record(&self, event: PolicyAuditEvent) {
            self.events.lock().expect("not poisoned").push(event);
        }
    }

    fn deny_everything() -> PolicyRule {
        PolicyRule {
            safe: PolicyAction::Deny,
            caution: PolicyAction::Deny,
            destructive: PolicyAction::Deny,
            catastrophic: PolicyAction::Deny,
        }
    }

    /// A vault holding one session of `protocol`, plus the core and the temp dir that owns the file.
    fn core_with_session(protocol: Protocol) -> (TempDir, Arc<Core>) {
        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");
        let session = sevenshell_types::Session {
            id: "session-under-test".to_owned(),
            name: "under test".to_owned(),
            group_id: None,
            protocol,
            host: "127.0.0.1".to_owned(),
            port: 2222,
            user: "someone".to_owned(),
            auth: SessionAuth::with_password(AuthMethod::Password),
            terminal: TerminalSettings::default(),
            desktop: sevenshell_types::DesktopSettings::default(),
            workbench: sevenshell_types::WorkbenchSettings::default(),
            telnet: sevenshell_types::TelnetSettings::default(),
            serial: sevenshell_types::SerialSettings::default(),
            local: sevenshell_types::LocalSettings::default(),
            wsl: sevenshell_types::WslSettings::default(),
            container: sevenshell_types::ContainerSettings::default(),
            kubernetes: sevenshell_types::KubernetesSettings::default(),
            webdav: sevenshell_types::WebDavSettings::default(),
            ftp: sevenshell_types::FtpSettings::default(),
            jump: Vec::new(),
            forwards: Vec::new(),
            updated_at: 0,
        };
        vault.save_session(session, None).expect("save");
        let (core, _events) = Core::new(vault);
        (directory, core)
    }

    fn tail_channels() -> (
        mpsc::UnboundedSender<TailStreamLine>,
        mpsc::UnboundedReceiver<TailStreamLine>,
        mpsc::UnboundedSender<TailStreamEnd>,
        mpsc::UnboundedReceiver<TailStreamEnd>,
    ) {
        let (events, lines) = mpsc::unbounded_channel();
        let (end, ends) = mpsc::unbounded_channel();
        (events, lines, end, ends)
    }

    #[test]
    fn a_hostile_path_stays_one_argument() {
        // The path holds a quote, a semicolon and a second command. Everything after the first
        // quote has to land inside the quoted argument, so the far side's shell sees one word and
        // the command ends with the closing quote — not with `rm -rf /` as a second command.
        let command = tail_command(200, "/tmp/a b'; rm -rf /");
        assert_eq!(command, "tail -n 200 -F -- '/tmp/a b'\\''; rm -rf /'");
        assert!(
            command.trim_end().ends_with("/'"),
            "the command ends inside the quoted path, not outside it: {command}"
        );
    }

    #[test]
    fn the_line_count_is_clamped_to_the_range_the_window_offers() {
        assert_eq!(tail_command(1, "/var/log/x"), "tail -n 10 -F -- '/var/log/x'");
        assert_eq!(tail_command(9, "/var/log/x"), "tail -n 10 -F -- '/var/log/x'");
        assert_eq!(tail_command(10, "/var/log/x"), "tail -n 10 -F -- '/var/log/x'");
        assert_eq!(tail_command(200, "/var/log/x"), "tail -n 200 -F -- '/var/log/x'");
        assert_eq!(tail_command(5000, "/var/log/x"), "tail -n 1000 -F -- '/var/log/x'");
    }

    #[tokio::test]
    async fn a_session_that_does_not_speak_ssh_is_refused_a_tail() {
        for protocol in [Protocol::Telnet, Protocol::Serial, Protocol::Rdp, Protocol::Container] {
            let (_directory, core) = core_with_session(protocol);
            let (events, _lines, end, _ends) = tail_channels();
            let error = core
                .file_tail_open("session-under-test", "/var/log/app.log", 200, events, end)
                .await
                .expect_err("the protocol gate refuses");
            assert_eq!(
                error.code(),
                sevenshell_error::ErrorCode::AppUnsupported,
                "{protocol:?}"
            );
            assert!(
                format!("{error:?}").contains("only on a session that speaks SSH"),
                "the refusal says what the session lacks: {error:?}"
            );
        }
    }

    #[tokio::test]
    async fn an_ssh_session_gets_as_far_as_its_credential() {
        // The gate itself passed if the failure is the missing password: policy ran, the carrier
        // was asked for, and the session simply has nothing to authenticate with. This separates
        // the protocol gate from everything after it without a network.
        let (_directory, core) = core_with_session(Protocol::Ssh);
        let (events, _lines, end, _ends) = tail_channels();

        let error = core
            .file_tail_open("session-under-test", "/var/log/app.log", 200, events, end)
            .await
            .expect_err("no password stored");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::SshAuthFailed);
    }

    #[tokio::test]
    async fn a_denied_tail_never_reaches_the_carrier_and_the_audit_line_names_the_path() {
        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");
        let mut session = sevenshell_types::Session {
            id: "session-under-test".to_owned(),
            name: "under test".to_owned(),
            protocol: Protocol::Ssh,
            ..serde_like_session()
        };
        session.host = "127.0.0.1".to_owned();
        vault.save_session(session, None).expect("save");

        let (core, _events) = Core::new(vault);
        let journal = Arc::new(RecordingJournal::default());
        core.set_policy(
            PolicyMatrix {
                global: deny_everything(),
                ..PolicyMatrix::default()
            },
            Some(Arc::clone(&journal) as Arc<dyn PolicyJournal>),
        );

        let (events, _lines, end, _ends) = tail_channels();
        let error = core
            .file_tail_open("session-under-test", "/var/log/private.log", 200, events, end)
            .await
            .expect_err("a deny refuses the tail");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let recorded = journal.events();
        assert_eq!(recorded.len(), 1, "one action, one line");
        assert_eq!(recorded[0].action, "tail.open");
        assert_eq!(recorded[0].subject.as_deref(), Some("/var/log/private.log"));
    }

    /// A session body with every field default-shaped, for the test above to name a protocol on.
    fn serde_like_session() -> sevenshell_types::Session {
        sevenshell_types::Session {
            id: String::new(),
            name: String::new(),
            group_id: None,
            protocol: Protocol::Ssh,
            host: String::new(),
            port: 22,
            user: String::new(),
            auth: SessionAuth::with_password(AuthMethod::Password),
            terminal: TerminalSettings::default(),
            desktop: sevenshell_types::DesktopSettings::default(),
            workbench: sevenshell_types::WorkbenchSettings::default(),
            telnet: sevenshell_types::TelnetSettings::default(),
            serial: sevenshell_types::SerialSettings::default(),
            local: sevenshell_types::LocalSettings::default(),
            wsl: sevenshell_types::WslSettings::default(),
            container: sevenshell_types::ContainerSettings::default(),
            kubernetes: sevenshell_types::KubernetesSettings::default(),
            webdav: sevenshell_types::WebDavSettings::default(),
            ftp: sevenshell_types::FtpSettings::default(),
            jump: Vec::new(),
            forwards: Vec::new(),
            updated_at: 0,
        }
    }

    #[tokio::test]
    async fn a_tail_of_a_session_that_is_not_there_is_named() {
        let (_directory, core) = core_with_session(Protocol::Ssh);
        let (events, _lines, end, _ends) = tail_channels();

        let error = core
            .file_tail_open("session-that-never-existed", "/var/log/app.log", 200, events, end)
            .await
            .expect_err("no such session");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::SessionNotFound);
    }

    #[tokio::test]
    async fn stopping_a_tail_that_is_not_there_is_not_an_error() {
        let (_directory, core) = core_with_session(Protocol::Ssh);

        assert!(core.file_tail_close("never-existed").await.is_ok());
        assert!(core.tail_streams.lock().await.is_empty());
    }

    #[tokio::test]
    async fn emit_lines_splits_on_newlines_and_drops_the_carriage_return() {
        let (events, mut lines, _end, _ends) = tail_channels();
        let mut pending = b"first\r\nsecond\nstill-open".to_vec();

        assert!(emit_lines(&mut pending, "tail-1", &events).await);
        assert_eq!(lines.recv().await.expect("first").line, "first");
        assert_eq!(lines.recv().await.expect("second").line, "second");
        assert_eq!(pending, b"still-open");
    }
}
