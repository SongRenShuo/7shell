//! The networks of a desktop's Docker engine.
//!
//! The surface reads like the container surface beside it: a list that folds the engine's own
//! answers, and two verbs behind the unattended gate. The one extra order here is the removal
//! guardrail — the engine counts the containers attached to the network before the `rm` is even
//! built, and a network that still holds containers is refused with its own error code, no matter
//! what the policy matrix says about `Caution`.

use sevenshell_error::ShellError;
use sevenshell_types::{NetworkCreateRequest, NetworkSummary};

use crate::Core;

impl Core {
    /// The networks of one engine, with their addresses and attached containers folded in.
    pub async fn network_list(&self, connection_id: &str) -> Result<Vec<NetworkSummary>, ShellError> {
        self.container_provider(connection_id)?.network_list().await
    }

    /// Creates one network from a request the interface filled in.
    ///
    /// The verdict is `Caution` — the daemon has its own opinions about addresses and drivers —
    /// and the decision is on the trail with the network named.
    pub async fn network_create(&self, connection_id: &str, request: &NetworkCreateRequest) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::network_action("create");
        self.container_unattended_gate("network.create", &verdict, Some(request.name.as_str()))?;
        self.container_provider(connection_id)?.network_create(request).await
    }

    /// Removes one network, through the engine's own removal guardrail.
    ///
    /// The gate runs first — a stricter layer's refusal arrives the way every unattended refusal
    /// arrives, with the rule named — and only then does the engine count what is attached. A
    /// network that still holds containers is refused with `CONTAINER-NETWORK-IN-USE`, and the
    /// refusal names the count, so the page can say what is holding it.
    pub async fn network_remove(&self, connection_id: &str, name: &str) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::network_action("remove");
        self.container_unattended_gate("network.remove", &verdict, Some(name))?;
        self.container_provider(connection_id)?
            .network_remove_guarded(name)
            .await
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
    async fn a_denied_network_create_never_reaches_the_runtime() {
        let (_directory, core, journal) = core_with(PolicyMatrix {
            global: deny_everything(),
            ..PolicyMatrix::default()
        });

        // The connection does not exist, so a lookup past the gate would say so instead. A deny
        // is answered first, which is the order this test is here to pin.
        let error = core
            .network_create(
                "connection-that-never-existed",
                &NetworkCreateRequest {
                    name: "mem-net-test".to_owned(),
                    ..NetworkCreateRequest::default()
                },
            )
            .await
            .expect_err("a deny refuses the create");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line");
        assert_eq!(events[0].action, "network.create");
        assert_eq!(events[0].decision, PolicyAction::Deny);
        assert_eq!(events[0].subject.as_deref(), Some("mem-net-test"));
    }

    #[tokio::test]
    async fn a_denied_network_removal_never_reaches_the_guardrail() {
        let (_directory, core, journal) = core_with(PolicyMatrix {
            global: deny_everything(),
            ..PolicyMatrix::default()
        });

        let error = core
            .network_remove("connection-that-never-existed", "mem-net-test")
            .await
            .expect_err("a deny refuses the removal");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "network.remove");
        assert_eq!(events[0].subject.as_deref(), Some("mem-net-test"));
    }

    #[tokio::test]
    async fn under_the_default_matrix_the_gate_passes_and_the_connection_lookup_answers() {
        let (_directory, core, journal) = core_with(PolicyMatrix::default());

        // Caution runs: what fails is the missing connection, not the policy. The trail carries
        // one allow line, which is what puts the decision on the record either way.
        let error = core
            .network_remove("connection-that-never-existed", "mem-net-test")
            .await
            .expect_err("no such connection");

        assert_ne!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        assert_ne!(error.code(), sevenshell_error::ErrorCode::PolicyApprovalRequired);
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, PolicyAction::Allow);
        assert_eq!(events[0].action, "network.remove");
    }

    #[tokio::test]
    async fn a_network_create_under_the_default_matrix_is_journaled_and_refused_by_the_missing_connection() {
        let (_directory, core, journal) = core_with(PolicyMatrix::default());

        let error = core
            .network_create(
                "connection-that-never-existed",
                &NetworkCreateRequest {
                    name: "mem-net-test".to_owned(),
                    subnet: "172.30.0.0/24".to_owned(),
                    ..NetworkCreateRequest::default()
                },
            )
            .await
            .expect_err("no such connection");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerNotConnected);
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].decision, PolicyAction::Allow);
        assert_eq!(events[0].action, "network.create");
    }
}
