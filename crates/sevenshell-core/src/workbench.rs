//! The desktop workbench's one action that reaches the far side.
//!
//! Almost everything the workbench shows is a surface the session's connection already carries —
//! the system mark, the monitor's sample, the file browser. The one thing it can ask the machine
//! to *do* is the power action, and it is held to the same shape the container workspace uses:
//! the verbs are fixed, the commands behind them are constants nobody types into, the policy
//! matrix decides what this installation does about the danger, and every decision leaves one
//! audit line. Unlike the container paths, a workbench session is a saved session, so its own
//! group, host and port layers apply — a `Deny` on a machine is a workbench that will not power
//! it off.
//!
//! The commands are deliberately plain: `shutdown -r now` and `shutdown -h now` are the two forms
//! every mainstream init answers, run as the user the session already authenticated as. Their
//! rights are the session's rights; nothing here elevates. And an unknown verb is refused before
//! any of it — there is no command behind a verb this module has not named.

use std::time::Duration;

use sevenshell_error::ShellError;
use sevenshell_types::{PolicyAction, Protocol, WorkbenchPowerOutcome};

use crate::sessions::Core;

/// How long the machine has to answer a power command. The action that works takes the
/// connection down with the machine, which ends the wait from the other side.
const POWER_TIMEOUT: Duration = Duration::from_secs(15);

/// The two commands the workbench can run on a machine, and neither is built from input. See the
/// module note for why these two forms and no others.
const REBOOT_COMMAND: &str = "shutdown -r now";
const SHUTDOWN_COMMAND: &str = "shutdown -h now";

impl Core {
    /// Runs one workbench power action after the policy verdict for it.
    ///
    /// The order is the container gate's, with one gate earlier: the verb itself. An action this
    /// module has no command for is refused before the session is even read — a refusal that
    /// cannot be argued into a run by any configuration of the matrix or the interface. And the
    /// policy decision comes before the handle is looked up, because a `Deny` is answered before
    /// any socket: the caller names both the session it is acting for and the handle it acts
    /// through, so the gate can use the session's own layers and still refuse a dead handle
    /// cheaply.
    pub async fn workbench_power(
        &self,
        session_id: &str,
        handle: &str,
        action: &str,
        acknowledged: bool,
    ) -> Result<WorkbenchPowerOutcome, ShellError> {
        let normalized = action.trim().to_ascii_lowercase();
        let command = match normalized.as_str() {
            "reboot" => REBOOT_COMMAND,
            "shutdown" => SHUTDOWN_COMMAND,
            _ => return Err(ShellError::app_unsupported("that workbench action does not exist")),
        };

        let session = self.session(session_id)?;
        if session.protocol != Protocol::LinuxDesk {
            return Err(ShellError::app_unsupported(
                "power actions belong to the desktop workbench",
            ));
        }

        let verdict = sevenshell_policy::workbench_action(&normalized);
        let saved = self.session_policy_target(session_id);
        let target = saved.as_ref().map(|saved| saved.as_target()).unwrap_or_default();
        let decision = self.policy_decision(
            &format!("workbench.{normalized}"),
            &verdict,
            target,
            Some(session_id),
            Some(&normalized),
        );
        match decision.action {
            PolicyAction::Deny => {
                return Err(ShellError::policy_denied(&format!("workbench.{normalized}")));
            }
            PolicyAction::Ask if !acknowledged => {
                let rule = verdict
                    .reasons
                    .first()
                    .map(|reason| reason.rule_id.as_str())
                    .unwrap_or("workbench.unknown");
                return Err(ShellError::policy_approval_required(rule));
            }
            _ => {}
        }

        let remote = self.registry.session_of(handle).await?;
        let outcome = remote.exec(command, POWER_TIMEOUT).await?;
        match outcome.exit_code {
            Some(0) => Ok(WorkbenchPowerOutcome { issued: true }),
            // A power action that reported no exit status has almost always taken the connection
            // down with the machine — which is the action working, not failing. An exit status
            // the machine did report is the machine's own answer.
            None => Ok(WorkbenchPowerOutcome { issued: true }),
            Some(_) => {
                let detail = if outcome.stderr.trim().is_empty() {
                    format!("exit code {:?}", outcome.exit_code)
                } else {
                    outcome.stderr.trim().to_owned()
                };
                Err(ShellError::workbench_power_failed(detail))
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

    fn core_with_policy(rule: PolicyRule) -> (TempDir, Arc<Core>, Arc<RecordingJournal>) {
        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");

        let mut session = sample("workbench-1", "a workbench machine");
        session.protocol = Protocol::LinuxDesk;
        vault.save_session(session, None).expect("save");

        let (core, _events): (Arc<Core>, _) = Core::new(vault);
        let journal = Arc::new(RecordingJournal::default());
        core.set_policy(PolicyMatrix { global: rule, ..PolicyMatrix::default() }, Some(Arc::clone(&journal) as Arc<dyn PolicyJournal>));
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
            updated_at: 0,
        }
    }

    #[tokio::test]
    async fn an_unknown_verb_is_refused_before_anything_is_read() {
        // Neither the session nor the handle names anything real, and the verb names nothing the
        // module has a command for: the refusal must be about the verb, which is the gate that
        // runs first.
        let (_directory, core, journal) = core_with_policy(PolicyRule::default());
        let error = core
            .workbench_power("session-that-never-existed", "handle-that-never-existed", "format", true)
            .await
            .expect_err("an unknown verb is refused");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
        assert!(journal.events().is_empty(), "nothing was decided, nothing is journaled");
    }

    #[tokio::test]
    async fn a_deny_refuses_the_power_action_even_when_acknowledged() {
        let (_directory, core, journal) = core_with_policy(deny_everything());

        // Acknowledged on purpose: an acknowledgement answers a question, it does not overrule a
        // deny. And the handle does not exist, so this proves the gate answers before any
        // connection lookup — the decision is about the machine the session names, not about
        // whether a channel is open.
        let error = core
            .workbench_power("workbench-1", "handle-that-never-existed", "reboot", true)
            .await
            .expect_err("a deny refuses the action");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line");
        assert_eq!(events[0].action, "workbench.reboot");
        assert_eq!(events[0].decision, PolicyAction::Deny);
        assert_eq!(events[0].subject.as_deref(), Some("reboot"));
    }

    #[tokio::test]
    async fn a_question_without_an_acknowledgement_names_the_rule() {
        // The default rule asks about destructive actions and lets everything else run; no layer
        // is set, so the ask comes from the global floor.
        let (_directory, core, journal) = core_with_policy(PolicyRule::default());

        let error = core
            .workbench_power("workbench-1", "handle-that-never-existed", "shutdown", false)
            .await
            .expect_err("a question stops the action");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyApprovalRequired);
        // An ask is a decision too, and it is on the trail like every other one — what the
        // absence of an acknowledgement changes is only that nothing ran.
        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line, asks included");
        assert_eq!(events[0].decision, PolicyAction::Ask);
    }

    #[tokio::test]
    async fn a_session_that_is_not_a_workbench_is_refused_by_the_protocol() {
        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");

        let mut session = sample("plain-ssh-1", "an ordinary SSH session");
        session.protocol = Protocol::Ssh;
        vault.save_session(session, None).expect("save");

        let (core, _events): (Arc<Core>, _) = Core::new(vault);
        // The protocol check runs before the policy gate: a plain SSH session named by a
        // workbench power action is a caller that is confused, not an installation that decided
        // anything — and the refusal names that, whatever the matrix says.
        let error = core
            .workbench_power("plain-ssh-1", "handle-that-never-existed", "reboot", true)
            .await
            .expect_err("only a workbench session powers a machine off");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
    }
}
