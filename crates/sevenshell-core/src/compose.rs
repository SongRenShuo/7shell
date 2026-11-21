//! The Compose projects of a desktop's Docker engine.
//!
//! The verbs are fixed and the argv is built in the runtime crate; what this layer owns is the
//! order: the policy verdict before the engine is even looked up, and — for the one verb that
//! touches the host's disk — the file channel the session already has. A Compose file reaches the
//! engine the way any text file does, over SFTP on the session's own carrier, with the path it
//! lands at named to the policy before anything is written.
//!
//! The capability bit is a fact learned once, at the open. Everything here is reachable only
//! through a desktop engine connection, which is what the reverse lookup at the bottom enforces.

use tokio::sync::mpsc::UnboundedSender;

use sevenshell_error::ShellError;
use sevenshell_types::{ComposeProject, ComposeServiceRow, ContainerStreamEnd, ContainerStreamLine};

use crate::Core;

/// What one desktop engine turned out to have, probed once when it opened.
pub(crate) struct DesktopEngineCaps {
    pub(crate) compose_available: bool,
    /// Whether the engine's command line can answer a remote-digest question — the image page's
    /// "check for updates". A CLI that cannot is a page that offers the manual pull only.
    pub(crate) manifest_inspect_available: bool,
    /// Whether the engine's event stream can be followed — the container list's automatic state
    /// updates. A CLI that cannot is a list that keeps its manual refresh, not an error.
    pub(crate) events_available: bool,
}

/// The longest Compose file path, and the longest file body, this surface will carry.
///
/// The path bound keeps a path a path; the body bound is a wizard's own ceiling — a Compose file
/// a person wrote by hand is a few kilobytes, and the file channel has no reason to carry more.
const MAX_YML_PATH_CHARS: usize = 1024;
const MAX_YML_BYTES: usize = 512 * 1024;

impl Core {
    /// The Compose projects of one engine, with their service and container counts folded in.
    pub async fn compose_ls(&self, connection_id: &str) -> Result<Vec<ComposeProject>, ShellError> {
        self.container_provider(connection_id)?.compose_ls().await
    }

    /// One project's services, as the engine's own `ps` sees them.
    pub async fn compose_ps(&self, connection_id: &str, name: &str) -> Result<Vec<ComposeServiceRow>, ShellError> {
        self.container_provider(connection_id)?.compose_ps(name).await
    }

    /// Brings one project up from the Compose file already on the engine's disk.
    ///
    /// Detached answers when the containers have started, and answers no stream. Attached hands
    /// back a stream id the interface follows — pulling and building are the sentences a person
    /// watches — with the lines arriving on the container stream channel the logs already use.
    pub async fn compose_up_start(
        &self,
        connection_id: &str,
        name: &str,
        yml_path: &str,
        detach: bool,
        events: UnboundedSender<ContainerStreamLine>,
        end: UnboundedSender<ContainerStreamEnd>,
    ) -> Result<Option<String>, ShellError> {
        let verdict = sevenshell_policy::compose_action("up");
        self.container_unattended_gate("compose.up", &verdict, Some(name))?;
        let stream = self
            .container_provider(connection_id)?
            .compose_up(name, yml_path, detach)
            .await?;
        Ok(match stream {
            Some(line_stream) => Some(self.spawn_container_stream(line_stream, events, end).await),
            None => None,
        })
    }

    /// Stops one project: its containers stop and go away.
    pub async fn compose_down(&self, connection_id: &str, name: &str) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::compose_action("down");
        self.container_unattended_gate("compose.down", &verdict, Some(name))?;
        self.container_provider(connection_id)?.compose_down(name).await
    }

    /// Restarts one project's containers.
    pub async fn compose_restart(&self, connection_id: &str, name: &str) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::compose_action("restart");
        self.container_unattended_gate("compose.restart", &verdict, Some(name))?;
        self.container_provider(connection_id)?.compose_restart(name).await
    }

    /// Follows one project's logs, newest tail first. The caller owns the stream id and stops it.
    pub async fn compose_logs_start(
        &self,
        connection_id: &str,
        name: &str,
        tail_lines: u32,
        events: UnboundedSender<ContainerStreamLine>,
        end: UnboundedSender<ContainerStreamEnd>,
    ) -> Result<String, ShellError> {
        let stream = self
            .container_provider(connection_id)?
            .compose_logs(name, tail_lines)
            .await?;
        Ok(self.spawn_container_stream(stream, events, end).await)
    }

    /// Writes a Compose file to the path the interface chose, on the engine's own host.
    ///
    /// The write goes through the session's file channel — the same carriers and the same
    /// semantics as every other text write — and the path is what the policy sees first: the
    /// gate carries the file's directory as its target, so a directory rule that forbids the
    /// location refuses the write before the channel opens. Nothing here runs a command; the
    /// `up` that consumes the file is its own verb.
    pub async fn compose_write_yaml(&self, connection_id: &str, yml_path: &str, yml: &str) -> Result<(), ShellError> {
        let yml_path = compose_yml_path(yml_path)?;
        if yml.len() > MAX_YML_BYTES {
            return Err(ShellError::container_command_failed(
                "the compose file",
                format!(
                    "the file is {} bytes and this build writes at most {MAX_YML_BYTES}",
                    yml.len()
                ),
            ));
        }
        let session_id = self.desktop_engine_session(connection_id).await?;
        let directory = directory_of(&yml_path);
        let session_target = self.session_policy_target(&session_id);
        let mut target = session_target
            .as_ref()
            .map(|session| session.as_target())
            .unwrap_or_default();
        target.directory = Some(&directory);
        self.unattended_gate(
            "compose.write_yaml",
            &sevenshell_policy::compose_action("write-yaml"),
            target,
            Some(&session_id),
            Some(&yml_path),
        )?;

        // The channel is opened for this one write and closed again: it is not a file browser,
        // and nothing in the interface holds the handle.
        let opened = self.open_files(&session_id).await?;
        let handle = match opened {
            sevenshell_types::SftpOutcome::Opened { handle, .. } => handle,
            other => return Err(files_outcome_refusal(other)),
        };
        let written = self.write_text_file(&handle, &yml_path, yml).await;
        let _ = self.close_files(&handle).await;
        written
    }

    /// The session whose carrier a desktop engine rides, for the verbs that touch the host
    /// rather than the engine.
    ///
    /// A connection id that is not a live desktop engine's is refused the way any unknown
    /// connection is, with the not-connected code.
    async fn desktop_engine_session(&self, connection_id: &str) -> Result<String, ShellError> {
        self.desktop_engines
            .lock()
            .await
            .iter()
            .find(|(_, mapped)| mapped.as_str() == connection_id)
            .map(|(session, _)| session.clone())
            .ok_or_else(|| ShellError::container_not_connected(connection_id))
    }
}

/// The path a Compose file may be written to. Absolute, because the command that consumes it
/// runs with the session's home as its working directory, and nothing that could be read as an
/// option or a second path survives the check.
fn compose_yml_path(path: &str) -> Result<String, ShellError> {
    let path = path.trim();
    let valid = path.starts_with('/')
        && path.chars().count() <= MAX_YML_PATH_CHARS
        && !path.chars().any(char::is_control)
        && !path.ends_with('/')
        && !path.contains("//");
    if valid {
        Ok(path.to_owned())
    } else {
        Err(ShellError::container_command_failed(
            "the compose file",
            format!("{path} is not an absolute remote path"),
        ))
    }
}

/// The directory a path lives in, which is what the directory layer of the policy matches.
fn directory_of(path: &str) -> String {
    match path.rsplit_once('/') {
        Some(("", _)) => "/".to_owned(),
        Some((directory, _)) => directory.to_owned(),
        None => "/".to_owned(),
    }
}

/// A file session that opened into a host-key decision rather than a handle. The desktop's own
/// file windows answer these with a prompt; a Compose write has nobody to ask, so the decision
/// arrives the way every other unattended refusal does.
fn files_outcome_refusal(outcome: sevenshell_types::SftpOutcome) -> ShellError {
    match outcome {
        sevenshell_types::SftpOutcome::HostKeyUnknown { key } => {
            ShellError::ssh_host_key_unknown(&key.host, key.port, &key.key_type)
        }
        sevenshell_types::SftpOutcome::HostKeyMismatch { trusted, .. } => {
            ShellError::ssh_host_key_mismatch(&trusted.host, trusted.port, &trusted.key_type)
        }
        sevenshell_types::SftpOutcome::Opened { .. } => {
            ShellError::app_internal("a file session opened twice for one Compose write")
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use sevenshell_policy::{PolicyAuditEvent, PolicyJournal};
    use sevenshell_types::{PolicyAction, PolicyMatrix, PolicyRule};
    use sevenshell_vault::Vault;
    use tempfile::tempdir;

    use super::*;

    #[derive(Default)]
    struct RecordingJournal {
        events: Mutex<Vec<PolicyAuditEvent>>,
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

    fn core_with(matrix: PolicyMatrix) -> (tempfile::TempDir, Arc<Core>, Arc<RecordingJournal>) {
        let directory = tempdir().expect("temp dir");
        let (core, _events) = Core::new(Arc::new(Vault::open_at(directory.path().join("vault.json"))));
        let journal = Arc::new(RecordingJournal::default());
        core.set_policy(matrix, Some(Arc::clone(&journal) as Arc<dyn PolicyJournal>));
        (directory, core, journal)
    }

    #[tokio::test]
    async fn a_denied_down_never_reaches_the_runtime() {
        let (_directory, core, journal) = core_with(PolicyMatrix {
            global: deny_everything(),
            ..PolicyMatrix::default()
        });

        let error = core
            .compose_down("connection-that-never-existed", "mem-compose-test")
            .await
            .expect_err("a deny refuses the down");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line");
        assert_eq!(events[0].action, "compose.down");
        assert_eq!(events[0].subject.as_deref(), Some("mem-compose-test"));
    }

    #[tokio::test]
    async fn a_denied_up_is_refused_before_the_engine_is_looked_up() {
        let (_directory, core, journal) = core_with(PolicyMatrix {
            global: deny_everything(),
            ..PolicyMatrix::default()
        });
        let (events, _lines) = tokio::sync::mpsc::unbounded_channel();
        let (end, _ends) = tokio::sync::mpsc::unbounded_channel();

        let error = core
            .compose_up_start(
                "connection-that-never-existed",
                "mem-compose-test",
                "/root/mem-compose-test/docker-compose.yml",
                true,
                events,
                end,
            )
            .await
            .expect_err("a deny refuses the up");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "compose.up");
    }

    #[tokio::test]
    async fn a_write_yaml_that_could_write_somewhere_else_is_refused() {
        let (_directory, core, _journal) = core_with(PolicyMatrix::default());

        for path in [
            "relative/compose.yml",
            "/root//x.yml",
            "/root/dir/",
            "  ",
            "-f",
            "/root/x\ny",
        ] {
            assert!(
                core.compose_write_yaml("desktop-live", path, "services: {}")
                    .await
                    .is_err(),
                "the path {path:?} was accepted"
            );
        }
    }

    #[tokio::test]
    async fn a_write_yaml_only_travels_for_a_live_desktop_engine() {
        let (_directory, core, journal) = core_with(PolicyMatrix::default());

        // An unknown connection is refused before anything else: there is no engine, so there is
        // nowhere the file could go.
        let error = core
            .compose_write_yaml("connection-that-never-existed", "/root/app/compose.yml", "services: {}")
            .await
            .expect_err("not a desktop engine");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerNotConnected);
        assert!(
            journal.events().is_empty(),
            "no decision line for a connection nobody knows"
        );

        // Mapped to a session, the gate runs with the file's directory as its target, and what
        // refuses after it is the missing session behind the file channel — not the policy.
        core.desktop_engines
            .lock()
            .await
            .insert("session-under-test".to_owned(), "desktop-live".to_owned());
        let error = core
            .compose_write_yaml("desktop-live", "/root/app/compose.yml", "services: {}")
            .await
            .expect_err("no such session to open a file channel on");
        assert_ne!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        assert_ne!(error.code(), sevenshell_error::ErrorCode::PolicyApprovalRequired);
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, PolicyAction::Allow);
        assert_eq!(events[0].action, "compose.write_yaml");
        assert_eq!(events[0].directory.as_deref(), Some("/root/app"));
        assert_eq!(events[0].subject.as_deref(), Some("/root/app/compose.yml"));
    }

    #[tokio::test]
    async fn a_denied_write_yaml_is_refused_before_any_channel_opens() {
        let (_directory, core, journal) = core_with(PolicyMatrix {
            global: deny_everything(),
            ..PolicyMatrix::default()
        });
        core.desktop_engines
            .lock()
            .await
            .insert("session-under-test".to_owned(), "desktop-live".to_owned());

        let error = core
            .compose_write_yaml("desktop-live", "/root/app/compose.yml", "services: {}")
            .await
            .expect_err("a deny refuses the write");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        assert!(
            core.files.lock().await.is_empty(),
            "no file session was opened for a refused write"
        );
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "compose.write_yaml");
        assert_eq!(events[0].decision, PolicyAction::Deny);
    }

    #[tokio::test]
    async fn the_directory_a_write_targets_is_what_the_policy_sees() {
        let (_directory, _core, _journal) = core_with(PolicyMatrix::default());

        // The reverse lookup fails first (no such engine), but the gate ran before it, which is
        // where the directory is derived. Refuse the path shapes directly instead:
        assert_eq!(directory_of("/root/app/compose.yml"), "/root/app");
        assert_eq!(directory_of("/compose.yml"), "/");
    }

    #[tokio::test]
    async fn dropping_a_desktop_engine_drops_its_capability_bits() {
        let (_directory, core, _journal) = core_with(PolicyMatrix::default());

        core.containers
            .connect(
                "desktop-live",
                sevenshell_types::ContainerRuntime::Docker,
                "",
                sevenshell_container::Runner::Local,
            )
            .expect("the engine");
        core.desktop_engine_caps.lock().await.insert(
            "desktop-live".to_owned(),
            DesktopEngineCaps {
                compose_available: true,
                manifest_inspect_available: false,
                events_available: false,
            },
        );
        assert!(core.desktop_engine_caps.lock().await.contains_key("desktop-live"));

        core.container_disconnect("desktop-live").await;

        assert!(
            !core.desktop_engine_caps.lock().await.contains_key("desktop-live"),
            "the bits are facts about a connection that is no longer there"
        );
    }

    #[tokio::test]
    async fn a_desktop_engine_connection_answers_its_session_for_the_file_channel() {
        let (_directory, core, _journal) = core_with(PolicyMatrix::default());

        core.desktop_engines
            .lock()
            .await
            .insert("session-a".to_owned(), "desktop-live".to_owned());
        assert_eq!(core.desktop_engine_session("desktop-live").await.unwrap(), "session-a");
        let error = core.desktop_engine_session("desktop-other").await.unwrap_err();
        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerNotConnected);
    }
}
