//! The Docker engine of a real Linux desktop session, opened on the connection the session holds.
//!
//! Ignored by default: it needs a running sshd with the account a person would use, and Docker on
//! the far side.
//!
//! ```text
//! SEVENSHELL_TEST_HOST=host SEVENSHELL_TEST_PORT=22 SEVENSHELL_TEST_USER=root \
//!   SEVENSHELL_TEST_PASSWORD=… cargo test -p sevenshell-core --test live_desktop_docker -- --ignored
//! ```
//!
//! The assertions are read-only and about plumbing, not about the host's fleet: the engine opens on
//! the session's own carrier, the container surface answers through it, logs can be followed, and
//! a disconnected engine is not resurrected. Nothing here stops or removes anything — the lab host
//! runs production databases.

use std::sync::Arc;
use std::time::Duration;

use sevenshell_core::Core;
use sevenshell_types::{AuthMethod, OpenOutcome, Session, SessionAuth, TerminalSettings};
use sevenshell_vault::{SessionSecret, Vault};
use tempfile::{TempDir, tempdir};
use tokio::sync::mpsc;
use tokio::time::timeout;

struct Lab {
    /// Owned so the vault file outlives the test.
    _directory: TempDir,
    core: Arc<Core>,
    session_id: String,
    /// Kept alive so a terminal's output has somewhere to go; the engine never reads it.
    _events: mpsc::Receiver<sevenshell_core::CoreEvent>,
}

fn environment(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

fn lab() -> Option<Lab> {
    let (Some(host), Some(port), Some(user), Some(password)) = (
        environment("SEVENSHELL_TEST_HOST"),
        environment("SEVENSHELL_TEST_PORT"),
        environment("SEVENSHELL_TEST_USER"),
        environment("SEVENSHELL_TEST_PASSWORD"),
    ) else {
        eprintln!("the SSH lab is not configured; skipping (set SEVENSHELL_TEST_HOST/PORT/USER/PASSWORD)");
        return None;
    };

    let Ok(port) = port.parse() else {
        eprintln!("SEVENSHELL_TEST_PORT is not a port number; skipping");
        return None;
    };

    let directory = tempdir().expect("temp dir");
    let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
    vault
        .create("the vault password, which is not the one under test")
        .expect("create");

    let session = Session {
        id: "lab-desktop".to_owned(),
        name: "lab desktop".to_owned(),
        group_id: None,
        protocol: sevenshell_types::Protocol::LinuxDesk,
        host,
        port,
        user,
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
    vault
        .save_session(session, Some(SessionSecret::Password(password)))
        .expect("save");

    let (core, events) = Core::new(vault);
    Some(Lab {
        _directory: directory,
        core,
        session_id: "lab-desktop".to_owned(),
        _events: events,
    })
}

impl Lab {
    /// Opens the session's terminal once to establish host-key trust — what a person does once —
    /// then closes it again, so the engine below opens its own carrier.
    async fn trust_then_close(&self) {
        for _ in 0..4 {
            match self.core.open_terminal(&self.session_id).await.expect("open") {
                OpenOutcome::Opened { handle, .. } => {
                    self.core.close_terminal(&handle).await.expect("close");
                    return;
                }
                OpenOutcome::HostKeyUnknown { key } => self.core.trust_host_key(&key).expect("trust"),
                other => panic!("expected the terminal to open, got {other:?}"),
            }
        }
        panic!("the route never finished asking");
    }
}

#[tokio::test]
#[ignore = "needs the SSH lab with Docker on the far side"]
async fn a_desktop_session_opens_its_docker_engine_on_its_own_connection() {
    let Some(lab) = lab() else {
        return;
    };
    lab.trust_then_close().await;

    let first = lab
        .core
        .desktop_engine_open(&lab.session_id)
        .await
        .expect("open the engine");
    assert!(
        first.starts_with("desktop-"),
        "the id the desktop keeps carries the desktop prefix: {first}"
    );

    // Idempotent per session: opening again answers the engine already riding the connection.
    let again = lab.core.desktop_engine_open(&lab.session_id).await.expect("reopen");
    assert_eq!(first, again, "the second open answers the engine the first one made");

    let containers = lab.core.container_list(&first).await.expect("list containers");
    eprintln!("containers: {}", containers.len());
    assert!(
        !containers.is_empty(),
        "the host answers its container fleet through the session's own carrier"
    );

    let stats = lab.core.container_stats(&first).await.expect("stats");
    eprintln!("stats rows: {}", stats.len());
    assert!(
        stats.iter().all(|sample| !sample.name.is_empty()),
        "every stats row names a container: {stats:?}"
    );

    // The tail of one container's logs, bounded by the tail flag, the timeout and the stop: this
    // follows the log only long enough to see it answer, then lets go.
    let target = &containers[0];
    let (events, mut lines) = mpsc::unbounded_channel();
    let (end, mut ends) = mpsc::unbounded_channel();
    let stream = lab
        .core
        .container_logs_start(&first, &target.id, 50, false, events, end)
        .await
        .expect("follow the container's logs");
    let mut collected = 0usize;
    let mut head = String::new();
    let _ = timeout(Duration::from_secs(15), async {
        loop {
            tokio::select! {
                line = lines.recv() => {
                    match line {
                        Some(row) => {
                            collected += 1;
                            if head.len() < 400 {
                                head.push_str(&row.line);
                            }
                        }
                        None => break,
                    }
                }
                _ = ends.recv() => break,
            }
        }
    })
    .await;
    lab.core.container_stream_stop(&stream).await;
    eprintln!("logs of {}: {collected} lines", target.name);
    assert!(collected > 0, "a followed log delivered something: {head:?}");

    // Dropping the engine and opening again makes a new one: a disconnected engine is never
    // resurrected under its old id.
    lab.core.container_disconnect(&first).await;
    let second = lab
        .core
        .desktop_engine_open(&lab.session_id)
        .await
        .expect("reopen after the disconnect");
    assert_ne!(first, second, "a disconnected engine is not handed out again");

    // Leave nothing running behind the test.
    lab.core.container_disconnect(&second).await;
}
