//! What a desktop's Docker engine pulls from, and whether a tag has moved.
//!
//! Both verbs here are reads: one reports the mirrors and proxy the daemon was given, and the
//! other asks the registry what digest a tag names now, beside what the engine already pulled.
//! Neither changes anything anywhere — the update itself is the existing pull surface, reached
//! only after a person has said so through the interface's own gate.

use sevenshell_error::ShellError;
use sevenshell_types::{ContainerImageRemoteDigest, ContainerRegistrySettings};

use crate::Core;

impl Core {
    /// Where one engine pulls from: the mirrors its daemon consults and the proxy it was told to
    /// use. A daemon configured with neither answers the empty shape, which is what the interface
    /// draws its empty sentences from.
    pub async fn docker_info(&self, connection_id: &str) -> Result<ContainerRegistrySettings, ShellError> {
        self.container_provider(connection_id)?.registry_settings().await
    }

    /// The digest the registry serves for one image tag now, beside the digests the local engine
    /// recorded for it.
    ///
    /// A registry that would not speak is its own code — the honest sentence is that whether a
    /// newer image exists is unknown, not that there is nothing newer.
    pub async fn image_remote_digest(
        &self,
        connection_id: &str,
        reference: &str,
    ) -> Result<ContainerImageRemoteDigest, ShellError> {
        self.container_provider(connection_id)?
            .image_remote_digest(reference)
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
    async fn a_denied_update_check_is_refused_before_the_engine_is_looked_up() {
        // The verbs are reads and run under the default matrix without a gate, but a stricter
        // layer's matrix still names them: the answer below is what the surface must show, and it
        // must arrive before any engine lookup would.
        let (_directory, core, journal) = core_with(PolicyMatrix {
            global: deny_everything(),
            ..PolicyMatrix::default()
        });

        let error = core
            .image_remote_digest("connection-that-never-existed", "busybox:1.37")
            .await
            .expect_err("no such connection");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerNotConnected);

        let error = core
            .docker_info("connection-that-never-existed")
            .await
            .expect_err("no such connection");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::ContainerNotConnected);
        assert!(
            journal.events().is_empty(),
            "a read without a gate leaves no decision line"
        );
    }
}
