//! The monitor's process page: its one write.
//!
//! Everything else on the process page reads (`/proc` through fixed commands), and this module is
//! the single exception — ending one process on the far side. It is held to the same shape as the
//! container and workbench gates: the verb is fixed, the command behind it is a constant with the
//! pid formatted as a number and nothing else (the monitor's own pid rule), the policy matrix
//! decides what this installation does about the danger with the session's own layers, and every
//! decision leaves one audit line. A signal that ends a service is `Destructive`, so no
//! configuration can run it unattended.
//!
//! This module lives beside `monitor` rather than inside it on purpose: the monitor file's whole
//! doctrine is read-only sampling, and a write in the middle of it would be a doctrine nobody
//! could trust without re-reading every function.

use std::time::Duration;

use sevenshell_error::ShellError;
use sevenshell_types::{PolicyAction, Protocol};

use crate::sessions::Core;

/// How long the machine has to answer a `kill`. The command returns as soon as the signal is
/// delivered; nothing here waits on the process to actually exit.
const KILL_TIMEOUT: Duration = Duration::from_secs(10);

impl Core {
    /// Ends one process after the policy verdict for it.
    ///
    /// The caller names both the session and the handle it acts through, so the policy decision —
    /// which uses the session's own group, host and port layers — comes before the handle is
    /// looked up, and a `Deny` is answered before any socket. The pid is a `u32` by the time this
    /// sees it: there is no string here for input to hide in.
    pub async fn kill_process(
        &self,
        session_id: &str,
        handle: &str,
        pid: u32,
        acknowledged: bool,
    ) -> Result<(), ShellError> {
        let session = self.session(session_id)?;
        // Both sessions that carry a terminal carry the process page; every other protocol has no
        // process table to act on.
        if !matches!(session.protocol, Protocol::Ssh | Protocol::LinuxDesk) {
            return Err(ShellError::app_unsupported(
                "ending a process belongs to an SSH session",
            ));
        }

        let verdict = sevenshell_policy::process_kill();
        let saved = self.session_policy_target(session_id);
        let target = saved.as_ref().map(|saved| saved.as_target()).unwrap_or_default();
        let decision = self.policy_decision(
            "process.kill",
            &verdict,
            target,
            Some(session_id),
            Some(&pid.to_string()),
        );
        match decision.action {
            PolicyAction::Deny => return Err(ShellError::policy_denied("process.kill")),
            PolicyAction::Ask if !acknowledged => {
                return Err(ShellError::policy_approval_required("process.kill"));
            }
            _ => {}
        }

        let remote = self.registry.session_of(handle).await?;
        // The pid is a number formatted as one: the command is `kill` with nothing behind the
        // signal and nothing inside the argument, which is the monitor's pid rule carried to its
        // first write.
        let command = format!("kill {pid}");
        let outcome = remote.exec(&command, KILL_TIMEOUT).await?;
        match outcome.exit_code {
            // `kill` reports success when the signal was delivered. A missing status here is not
            // the machine going away (nothing about a signal takes the connection down), so it is
            // an anomaly, and the stderr is what the person needs.
            Some(0) => Ok(()),
            _ => {
                let detail = if outcome.stderr.trim().is_empty() {
                    format!("exit code {:?}", outcome.exit_code)
                } else {
                    outcome.stderr.trim().to_owned()
                };
                Err(ShellError::process_kill_failed(detail))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use sevenshell_policy::{PolicyAuditEvent, PolicyJournal};
    use sevenshell_types::{AuthMethod, PolicyAction, PolicyMatrix, PolicyRule, SessionAuth, TerminalSettings};
    use tempfile::{TempDir, tempdir};

    use super::*;
    use sevenshell_vault::Vault;

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

    fn core_with_policy(rule: PolicyRule, protocol: Protocol) -> (TempDir, Arc<Core>, Arc<RecordingJournal>) {
        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");

        let mut session = sample("session-1", "a machine");
        session.protocol = protocol;
        vault.save_session(session, None).expect("save");

        let (core, _events): (Arc<Core>, _) = Core::new(vault);
        let journal = Arc::new(RecordingJournal::default());
        core.set_policy(
            PolicyMatrix {
                global: rule,
                ..PolicyMatrix::default()
            },
            Some(Arc::clone(&journal) as Arc<dyn PolicyJournal>),
        );
        (directory, core, journal)
    }

    fn sample(id: &str, name: &str) -> sevenshell_types::Session {
        sevenshell_types::Session {
            id: id.to_owned(),
            name: name.to_owned(),
            group_id: None,
            protocol: Protocol::Ssh,
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
            order: None,
            vmware: sevenshell_types::VmwareSettings::default(),
            updated_at: 0,
        }
    }

    #[tokio::test]
    async fn a_deny_refuses_the_kill_even_when_acknowledged() {
        let (_directory, core, journal) = core_with_policy(deny_everything(), Protocol::Ssh);

        // Acknowledged on purpose, and the handle names nothing: the decision must answer before
        // any connection lookup, which is what the error's code proves.
        let error = core
            .kill_process("session-1", "handle-that-never-existed", 4196, true)
            .await
            .expect_err("a deny refuses the action");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line");
        assert_eq!(events[0].action, "process.kill");
        assert_eq!(events[0].decision, PolicyAction::Deny);
        assert_eq!(events[0].subject.as_deref(), Some("4196"));
    }

    #[tokio::test]
    async fn a_question_without_an_acknowledgement_is_a_decision_on_the_trail() {
        let (_directory, core, journal) = core_with_policy(PolicyRule::default(), Protocol::Ssh);

        let error = core
            .kill_process("session-1", "handle-that-never-existed", 4196, false)
            .await
            .expect_err("a question stops the action");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyApprovalRequired);
        let events = journal.events();
        assert_eq!(events.len(), 1, "asks are journaled like every other decision");
        assert_eq!(events[0].decision, PolicyAction::Ask);
    }

    #[tokio::test]
    async fn a_session_without_a_process_table_is_refused_by_the_protocol() {
        let (_directory, core, journal) = core_with_policy(PolicyRule::default(), Protocol::WebDav);

        let error = core
            .kill_process("session-1", "handle-that-never-existed", 4196, true)
            .await
            .expect_err("only SSH-carrying sessions have a process table");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
        assert!(journal.events().is_empty(), "refused before any decision");
    }
}
