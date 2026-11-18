//! Container connections: the order in which the vault, the SSH route and the runtime are used.
//!
//! A container session names a runtime and where it runs. The first decision is the transport:
//! a process on this machine needs nothing but a `PATH`, while an SSH host needs the saved session
//! it references opened with the same route, probe and host-key verification a terminal gets. Only
//! then is a provider registered under an id the interface keeps.
//!
//! Destructive operations are decided here, before the connection is looked up, so an
//! unacknowledged stop or removal fails the same way whether or not a runtime is reachable.

use std::path::Path;
use std::sync::Arc;

use sevenshell_container::{LineStream, Provider, Runner};
use sevenshell_error::ShellError;
use sevenshell_policy::PolicyTarget;
use sevenshell_session::{ForwardedControl, ForwardedSession};
use sevenshell_types::{
    ContainerCommitRequest, ContainerCreateRequest, ContainerDetail, ContainerImage, ContainerImageTransfer,
    ContainerRegistryLogin, ContainerRuntime, ContainerRuntimeInfo, ContainerStats, ContainerStreamEnd,
    ContainerStreamLine, ContainerSummary, ContainerTransport, ImageLayer, PolicyAction, Protocol, RiskAssessment,
};
use tokio::sync::mpsc::{self, UnboundedSender};

use crate::Core;
use crate::sessions::{ConnectionOutcome, HostKeyDecision};

impl Core {
    /// Opens the runtime a saved session names, and answers the id the interface keeps.
    pub async fn container_connect(&self, session_id: &str) -> Result<String, ShellError> {
        let session = self.session(session_id)?;
        if session.protocol != Protocol::Container {
            return Err(ShellError::app_unsupported(
                "a container connection was asked for a session that is not a container session",
            ));
        }

        let settings = &session.container;
        let runner = match settings.transport {
            ContainerTransport::Local => Runner::Local,
            ContainerTransport::Ssh => {
                let referenced = settings.ssh_session.trim();
                if referenced.is_empty() {
                    return Err(ShellError::app_unsupported(
                        "this container session has no SSH session to reach the runtime through",
                    ));
                }
                let transport = self.session(referenced)?;
                if transport.protocol != Protocol::Ssh {
                    return Err(ShellError::app_unsupported(
                        "the session a container connection references is not an SSH session",
                    ));
                }
                match self.open_carrier(&transport).await? {
                    ConnectionOutcome::Ready(carrier) => Runner::Ssh(carrier.connection),
                    // A container workspace has no host-key prompt of its own. Refusing with the
                    // host's identity is honest: opening that SSH session once is how the decision
                    // is made, and every later container connection reuses the trust.
                    ConnectionOutcome::Decision(decision) => return Err(decision_error(*decision)),
                }
            }
        };

        let namespace = if settings.runtime == ContainerRuntime::Nerdctl {
            let namespace = settings.namespace.trim();
            if namespace.is_empty() { "default" } else { namespace }
        } else {
            ""
        };

        let id = self.containers.new_id();
        self.containers
            .connect(id.clone(), settings.runtime, namespace, runner)?;
        Ok(id)
    }

    /// Drops a connection and every stream it was feeding.
    pub async fn container_disconnect(&self, connection_id: &str) {
        let stops: Vec<_> = {
            let mut streams = self.container_streams.lock().await;
            streams.drain().map(|(_, stop)| stop).collect()
        };
        for stop in stops {
            stop();
        }
        self.containers.remove(connection_id);
        // A desktop engine is mapped by the session that opened it; dropping the connection forgets
        // the mapping, so the next open cannot resurrect a dead id.
        self.desktop_engines
            .lock()
            .await
            .retain(|_, mapped| mapped != connection_id);
    }

    /// Opens the Docker engine of a Linux desktop session on the connection that session holds.
    ///
    /// The desktop's Docker manager rides the same SSH carrier the session's file windows and
    /// trash use — one connection per session, not one per panel. Everything after the open (list,
    /// inspect, logs, exec, actions) is the container workspace's own surface, addressed by the id
    /// this answers.
    ///
    /// The call is idempotent per session: opening again answers the id the first open handed out,
    /// as long as that connection still answers. A mapping whose connection is gone — disconnected
    /// here, which also clears the mapping, or retired any other way — is forgotten rather than
    /// resurrected, and a fresh connection opens in its place.
    pub async fn desktop_engine_open(&self, session_id: &str) -> Result<String, ShellError> {
        let session = self.session(session_id)?;
        if session.protocol != Protocol::LinuxDesk {
            return Err(ShellError::app_unsupported(
                "a desktop Docker engine was asked for a session that is not a Linux desktop session",
            ));
        }

        if let Some(id) = self.desktop_engine_to_reuse(session_id).await {
            return Ok(id);
        }

        let runner = match self.open_carrier(&session).await? {
            ConnectionOutcome::Ready(carrier) => Runner::Ssh(carrier.connection),
            // The desktop has no host-key prompt of its own, for the same reason a container
            // workspace does not: opening that SSH session once is how the decision is made, and
            // every later engine open reuses the trust.
            ConnectionOutcome::Decision(decision) => return Err(decision_error(*decision)),
        };

        // Docker takes no namespace; that flag is a nerdctl concern (see `container_connect`).
        let id = format!("desktop-{}", uuid::Uuid::new_v4());
        self.containers
            .connect(id.clone(), ContainerRuntime::Docker, "", runner)?;
        self.desktop_engines
            .lock()
            .await
            .insert(session_id.to_owned(), id.clone());
        Ok(id)
    }

    /// The connection id a session's desktop engine may be reused under, if its mapping is alive.
    ///
    /// A mapping whose connection no longer resolves is dropped here: the stale-check on open is
    /// the contract for a mapping that outlived its manager entry, and `container_disconnect` is
    /// the first line of defence for the ordinary path.
    async fn desktop_engine_to_reuse(&self, session_id: &str) -> Option<String> {
        let mut engines = self.desktop_engines.lock().await;
        match engines.get(session_id).cloned() {
            Some(id) if self.containers.provider(&id).is_ok() => Some(id),
            Some(_) => {
                engines.remove(session_id);
                None
            }
            None => None,
        }
    }

    pub async fn container_list(&self, connection_id: &str) -> Result<Vec<ContainerSummary>, ShellError> {
        self.container_provider(connection_id)?.list().await
    }

    pub async fn container_inspect(
        &self,
        connection_id: &str,
        container_id: &str,
    ) -> Result<ContainerDetail, ShellError> {
        self.container_provider(connection_id)?.inspect(container_id).await
    }

    /// Runs one container action after the policy verdict for it.
    pub async fn container_action(
        &self,
        connection_id: &str,
        container_id: &str,
        action: &str,
        acknowledged: bool,
    ) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::container_action(action);
        self.container_gate(
            &format!("container.{action}"),
            &verdict,
            acknowledged,
            "container.unknown",
            Some(container_id),
        )?;
        self.container_provider(connection_id)?
            .action(container_id, action)
            .await
    }

    pub async fn container_rename(
        &self,
        connection_id: &str,
        container_id: &str,
        name: &str,
    ) -> Result<(), ShellError> {
        self.container_provider(connection_id)?.rename(container_id, name).await
    }

    pub async fn container_create(
        &self,
        connection_id: &str,
        request: &ContainerCreateRequest,
    ) -> Result<(), ShellError> {
        self.container_provider(connection_id)?.create(request).await
    }

    pub async fn container_stats(&self, connection_id: &str) -> Result<Vec<ContainerStats>, ShellError> {
        self.container_provider(connection_id)?.stats().await
    }

    pub async fn container_namespaces(&self, connection_id: &str) -> Result<Vec<String>, ShellError> {
        self.container_provider(connection_id)?.namespaces().await
    }

    pub fn container_set_namespace(&self, connection_id: &str, namespace: &str) -> Result<(), ShellError> {
        self.containers.set_namespace(connection_id, namespace)
    }

    pub async fn container_runtime_info(&self, connection_id: &str) -> Result<ContainerRuntimeInfo, ShellError> {
        self.container_provider(connection_id)?.runtime_info().await
    }

    pub async fn container_images(&self, connection_id: &str) -> Result<Vec<ContainerImage>, ShellError> {
        self.container_provider(connection_id)?.images().await
    }

    pub async fn container_image_inspect(&self, connection_id: &str, image: &str) -> Result<String, ShellError> {
        self.container_provider(connection_id)?.image_inspect(image).await
    }

    pub async fn container_image_history(
        &self,
        connection_id: &str,
        image: &str,
    ) -> Result<Vec<ImageLayer>, ShellError> {
        self.container_provider(connection_id)?.image_history(image).await
    }

    pub async fn container_image_remove(
        &self,
        connection_id: &str,
        image: &str,
        acknowledged: bool,
    ) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::container_action("image-remove");
        self.container_gate(
            "container.image-remove",
            &verdict,
            acknowledged,
            "container.remove",
            Some(image),
        )?;
        self.container_provider(connection_id)?.image_remove(image).await
    }

    pub async fn container_image_prune(&self, connection_id: &str, acknowledged: bool) -> Result<(), ShellError> {
        let verdict = sevenshell_policy::container_action("prune");
        self.container_gate("container.prune", &verdict, acknowledged, "container.remove", None)?;
        self.container_provider(connection_id)?.image_prune().await
    }

    pub async fn container_image_tag(&self, connection_id: &str, image: &str, tag: &str) -> Result<(), ShellError> {
        self.container_provider(connection_id)?.image_tag(image, tag).await
    }

    /// Loads an image archive from a file the person chose in a native dialog.
    ///
    /// The path stays on this side of the window: it is never handed to the interface, and it never
    /// becomes part of a command line — the archive's bytes reach the runtime on standard input, as
    /// they are read from the file.
    pub async fn container_image_load(&self, connection_id: &str, archive: &Path) -> Result<String, ShellError> {
        self.container_image_load_transfer(connection_id, archive).await
    }

    pub async fn container_image_commit(
        &self,
        connection_id: &str,
        request: &ContainerCommitRequest,
        acknowledged: bool,
    ) -> Result<String, ShellError> {
        let verdict = sevenshell_policy::container_action("commit");
        self.container_gate("container.commit", &verdict, acknowledged, "container.change", None)?;
        self.container_provider(connection_id)?.image_commit(request).await
    }

    pub async fn container_registry_login(
        &self,
        connection_id: &str,
        login: &ContainerRegistryLogin,
    ) -> Result<(), ShellError> {
        self.container_provider(connection_id)?.registry_login(login).await
    }

    /// Follows a container's logs, sending every line to `events` and the end to `end`.
    pub async fn container_logs_start(
        &self,
        connection_id: &str,
        container_id: &str,
        tail: u32,
        timestamps: bool,
        events: UnboundedSender<ContainerStreamLine>,
        end: UnboundedSender<ContainerStreamEnd>,
    ) -> Result<String, ShellError> {
        let stream = self
            .container_provider(connection_id)?
            .logs(container_id, tail, timestamps)
            .await?;
        Ok(self.spawn_container_stream(stream, events, end).await)
    }

    /// Starts a pull or a push, whose output is the CLI's own progress lines.
    pub async fn container_image_transfer_start(
        &self,
        connection_id: &str,
        request: &ContainerImageTransfer,
        push: bool,
        events: UnboundedSender<ContainerStreamLine>,
        end: UnboundedSender<ContainerStreamEnd>,
    ) -> Result<String, ShellError> {
        let provider = self.container_provider(connection_id)?;
        let stream = if push {
            provider.image_push(request).await?
        } else {
            provider.image_pull(request).await?
        };
        Ok(self.spawn_container_stream(stream, events, end).await)
    }

    pub async fn container_stream_stop(&self, stream_id: &str) {
        let stop = self.container_streams.lock().await.remove(stream_id);
        if let Some(stop) = stop {
            stop();
        }
    }

    /// Opens an exec terminal and registers it with the terminal registry.
    pub async fn container_exec_open(
        &self,
        connection_id: &str,
        container_id: &str,
        shell: &str,
        columns: u32,
        rows: u32,
    ) -> Result<String, ShellError> {
        let mut terminal = self
            .container_provider(connection_id)?
            .open_exec(container_id, shell, columns, rows)
            .await?;

        let output = terminal.take_output();
        let (control, mut requests) = mpsc::channel(32);
        tokio::spawn(async move {
            while let Some(request) = requests.recv().await {
                let applied = match request {
                    ForwardedControl::Write(bytes) => terminal.write(&bytes).await,
                    ForwardedControl::Resize { columns, rows } => terminal.resize(columns, rows).await,
                    ForwardedControl::Close => break,
                };
                if applied.is_err() {
                    break;
                }
            }
            let _ = terminal.close().await;
        });

        self.registry
            .open_forwarded(connection_id, ForwardedSession::new(output, control), None)
            .await
    }

    fn container_provider(&self, connection_id: &str) -> Result<Arc<Provider>, ShellError> {
        self.containers.provider(connection_id)
    }

    async fn spawn_container_stream(
        &self,
        mut stream: LineStream,
        events: UnboundedSender<ContainerStreamLine>,
        end: UnboundedSender<ContainerStreamEnd>,
    ) -> String {
        let stream_id = uuid::Uuid::new_v4().to_string();
        let registry = Arc::clone(&self.container_streams);
        registry.lock().await.insert(stream_id.clone(), stream.stopper());

        let task_id = stream_id.clone();
        tokio::spawn(async move {
            while let Some(line) = stream.next().await {
                let event = ContainerStreamLine {
                    stream_id: task_id.clone(),
                    line,
                };
                if events.send(event).is_err() {
                    break;
                }
            }
            registry.lock().await.remove(&task_id);
            let _ = end.send(ContainerStreamEnd {
                stream_id: task_id,
                error: None,
            });
        });

        stream_id
    }
}

/// Turns a host-key decision into the refusal a workspace can show without a prompt.
///
/// Crate-visible because the tail and the runtime forwards ride the same carrier and answer the
/// same decisions with the same refusal.
pub(crate) fn decision_error(decision: HostKeyDecision) -> ShellError {
    match decision {
        HostKeyDecision::Unknown(key) => ShellError::ssh_host_key_unknown(&key.host, key.port, &key.key_type),
        HostKeyDecision::Mismatch { trusted, .. } => {
            ShellError::ssh_host_key_mismatch(&trusted.host, trusted.port, &trusted.key_type)
        }
    }
}

impl Core {
    /// One container action's policy verdict, made before the runtime is looked up.
    ///
    /// The target is the global rule only: a container connection has no saved session id on this
    /// side, and naming a group or host layer here would be an audit line about a layer that never
    /// looked at the action. The session's own score is enforced where the session is known — the
    /// tool layer's gate — not invented here.
    fn container_gate(
        &self,
        operation: &str,
        verdict: &RiskAssessment,
        acknowledged: bool,
        fallback_rule: &str,
        subject: Option<&str>,
    ) -> Result<(), ShellError> {
        let decision = self.policy_decision(operation, verdict, PolicyTarget::default(), None, subject);
        match decision.action {
            PolicyAction::Deny => Err(ShellError::policy_denied(operation)),
            PolicyAction::Ask if !acknowledged => {
                let rule = verdict
                    .reasons
                    .first()
                    .map_or(fallback_rule, |reason| reason.rule_id.as_str());
                Err(ShellError::policy_approval_required(rule))
            }
            _ => Ok(()),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use sevenshell_policy::{PolicyAuditEvent, PolicyJournal};
    use sevenshell_types::{PolicyMatrix, PolicyRule};
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

    fn core_with_denial() -> (tempfile::TempDir, Arc<Core>, Arc<RecordingJournal>) {
        let directory = tempdir().expect("temp dir");
        let (core, _events) = Core::new(Arc::new(Vault::open_at(directory.path().join("vault.json"))));
        let journal = Arc::new(RecordingJournal::default());
        core.set_policy(
            PolicyMatrix {
                global: deny_everything(),
                ..PolicyMatrix::default()
            },
            Some(Arc::clone(&journal) as Arc<dyn PolicyJournal>),
        );
        (directory, core, journal)
    }

    #[tokio::test]
    async fn a_denied_container_action_never_reaches_the_runtime_even_when_acknowledged() {
        let (_directory, core, journal) = core_with_denial();

        // Acknowledged on purpose: an acknowledgement answers a question, it does not overrule a
        // deny. And the connection does not exist, so any lookup would say so instead.
        let error = core
            .container_action("connection-that-never-existed", "web", "stop", true)
            .await
            .expect_err("a deny refuses the action");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1, "one action, one line");
        assert_eq!(events[0].action, "container.stop");
        assert_eq!(events[0].decision, PolicyAction::Deny);
        assert_eq!(events[0].subject.as_deref(), Some("web"));
    }

    #[tokio::test]
    async fn deleting_an_image_is_refused_by_the_same_gate() {
        let (_directory, core, journal) = core_with_denial();

        let error = core
            .container_image_remove("connection-that-never-existed", "registry.test/app:1", true)
            .await
            .expect_err("a deny refuses the removal");

        assert_eq!(error.code(), sevenshell_error::ErrorCode::PolicyDenied);
        let events = journal.events();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].action, "container.image-remove");
    }

    /// A vault holding one session of `protocol`, plus the core and the temp dir that owns the file.
    fn core_with_session(protocol: Protocol) -> (tempfile::TempDir, Arc<Core>) {
        use sevenshell_types::{AuthMethod, Session, SessionAuth, TerminalSettings};

        let directory = tempdir().expect("temp dir");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault.create("correct horse battery staple").expect("create");
        let session = Session {
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

    #[tokio::test]
    async fn a_session_that_is_not_a_linux_desktop_is_refused_a_desktop_engine() {
        for protocol in [Protocol::Ssh, Protocol::Container, Protocol::LinuxDesk] {
            let (_directory, core) = core_with_session(protocol);
            let result = core.desktop_engine_open("session-under-test").await;
            if protocol == Protocol::LinuxDesk {
                // A desktop session with no stored password is refused before any network use —
                // the gate itself passed, which is what this loop is here to separate.
                let error = result.expect_err("no password stored");
                assert_eq!(error.code(), sevenshell_error::ErrorCode::SshAuthFailed);
            } else {
                let error = result.expect_err("the protocol gate refuses");
                assert_eq!(error.code(), sevenshell_error::ErrorCode::AppUnsupported);
                assert!(
                    format!("{error:?}").contains("not a Linux desktop session"),
                    "the refusal names the kind of session it was given: {error:?}"
                );
            }
        }
    }

    #[tokio::test]
    async fn a_desktop_engine_mapping_that_still_answers_is_reused_and_a_dead_one_is_forgotten() {
        let (_directory, core) = core_with_session(Protocol::LinuxDesk);

        core.desktop_engines
            .lock()
            .await
            .insert("session-under-test".to_owned(), "desktop-live".to_owned());
        core.containers
            .connect("desktop-live", ContainerRuntime::Docker, "", Runner::Local)
            .expect("the mapped engine answers");

        assert_eq!(
            core.desktop_engine_to_reuse("session-under-test").await.as_deref(),
            Some("desktop-live"),
            "a live mapping is the id the next open answers"
        );

        // The manager entry is gone (disconnected, retired); the mapping must not resurrect it.
        core.containers.remove("desktop-live");
        assert_eq!(core.desktop_engine_to_reuse("session-under-test").await, None);
        assert!(
            core.desktop_engines.lock().await.get("session-under-test").is_none(),
            "the dead mapping was dropped, not kept for the next open to trip over"
        );
    }

    #[tokio::test]
    async fn disconnecting_a_connection_clears_the_desktop_mapping_it_answered() {
        let (_directory, core) = core_with_session(Protocol::LinuxDesk);

        core.containers
            .connect("desktop-one", ContainerRuntime::Docker, "", Runner::Local)
            .expect("first engine");
        core.containers
            .connect("desktop-two", ContainerRuntime::Docker, "", Runner::Local)
            .expect("second engine");
        let mut engines = core.desktop_engines.lock().await;
        engines.insert("session-a".to_owned(), "desktop-one".to_owned());
        engines.insert("session-b".to_owned(), "desktop-two".to_owned());
        drop(engines);

        core.container_disconnect("desktop-one").await;

        let engines = core.desktop_engines.lock().await;
        assert!(engines.get("session-a").is_none(), "the dropped engine is forgotten");
        assert_eq!(
            engines.get("session-b").map(String::as_str),
            Some("desktop-two"),
            "an engine on another session is untouched"
        );
    }
}
