//! The Compose surface of a real Linux desktop session's Docker engine.
//!
//! Ignored by default: it needs the SSH lab with Docker and the Compose plugin on the far side.
//!
//! ```text
//! SEVENSHELL_TEST_HOST=host SEVENSHELL_TEST_PORT=22 SEVENSHELL_TEST_USER=root \
//!   SEVENSHELL_TEST_PASSWORD=… cargo test -p sevenshell-core --test live_desktop_compose -- --ignored
//! ```
//!
//! The project is the test's own: a directory the test makes under /root, one nginx service on a
//! high port, brought up detached, read, followed, brought down, and the directory removed. The
//! engine's own projects are only read through `compose ls`.

use std::sync::Arc;
use std::time::Duration;

use sevenshell_core::Core;
use sevenshell_types::{AuthMethod, OpenOutcome, Protocol, Session, SessionAuth, TerminalSettings};
use sevenshell_vault::{SessionSecret, Vault};
use tempfile::{TempDir, tempdir};
use tokio::time::timeout;

const PROJECT: &str = "mem-compose-test";
const PROJECT_DIR: &str = "/root/mem-compose-test";
const PROJECT_YML: &str = "/root/mem-compose-test/nginx/docker-compose.yml";
const PROJECT_BODY: &str = "services:\n  nginx:\n    image: nginx:1.27\n    ports:\n      - \"18080:80\"\n";

struct Lab {
    /// Owned so the vault file outlives the test.
    _directory: TempDir,
    core: Arc<Core>,
    session_id: String,
    /// Kept alive so a terminal's output has somewhere to go; the engine never reads it.
    _events: tokio::sync::mpsc::Receiver<sevenshell_core::CoreEvent>,
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
        protocol: Protocol::LinuxDesk,
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

    /// A file channel for the directory work, opened and closed around one call.
    async fn with_files<F>(&self, work: F)
    where
        F: AsyncFnOnce(&String),
    {
        let opened = self
            .core
            .open_files(&self.session_id)
            .await
            .expect("open the file channel");
        let sevenshell_types::SftpOutcome::Opened { handle, .. } = opened else {
            panic!("the file channel opened into {opened:?}");
        };
        work(&handle).await;
        self.core.close_files(&handle).await.expect("close the file channel");
    }
}

#[tokio::test]
#[ignore = "needs the SSH lab with Docker and its Compose plugin on the far side"]
async fn a_compose_project_is_written_started_read_and_taken_down() {
    let Some(lab) = lab() else {
        return;
    };
    lab.trust_then_close().await;

    let engine = lab
        .core
        .desktop_engine_open(&lab.session_id)
        .await
        .expect("open the engine");
    let info = lab.core.container_runtime_info(&engine).await.expect("engine info");
    if !info.compose_available {
        eprintln!("the engine answers no Compose plugin; the overview-only path is the contract, skipping");
        lab.core.container_disconnect(&engine).await;
        return;
    }
    eprintln!("compose plugin: available");

    // The directory the project lives in is made by the test, through the file channel, the way
    // the wizard's own directory picker would.
    lab.with_files(async |handle| {
        for directory in [PROJECT_DIR.to_owned(), format!("{PROJECT_DIR}/nginx")] {
            if let Err(error) = lab.core.create_folder(handle, &directory).await {
                // An earlier run that failed mid-test may have left it; an existing directory is
                // not a failure of this one.
                eprintln!("mkdir {directory}: {error}");
            }
        }
    })
    .await;

    // The file reaches the host through the same channel, gated by compose.write_yaml.
    lab.core
        .compose_write_yaml(&engine, PROJECT_YML, PROJECT_BODY)
        .await
        .expect("write the compose file");
    let projects = lab.core.compose_ls(&engine).await.expect("list projects");
    eprintln!(
        "projects before up: {:?}",
        projects.iter().map(|row| row.name.clone()).collect::<Vec<_>>()
    );
    assert!(
        !projects.iter().any(|row| row.name == PROJECT),
        "a project that was never upped is not in the engine's list yet"
    );

    // Up, detached: the answer is None, and the project appears with its services folded in.
    let stream = lab
        .core
        .compose_up_start(
            &engine,
            PROJECT,
            PROJECT_YML,
            true,
            tokio::sync::mpsc::unbounded_channel().0,
            tokio::sync::mpsc::unbounded_channel().0,
        )
        .await
        .expect("up the project");
    assert_eq!(stream, None, "a detached up has no stream to follow");

    // The engine pulls and starts; the service row arrives when the container is up.
    let mut services = Vec::new();
    timeout(Duration::from_secs(90), async {
        for _ in 0..90 {
            if let Ok(rows) = lab.core.compose_ps(&engine, PROJECT).await
                && rows.iter().any(|row| row.service == "nginx" && row.state == "running")
            {
                services = rows;
                return;
            }
            tokio::time::sleep(Duration::from_secs(1)).await;
        }
    })
    .await
    .expect("the nginx service reaches running within the wait");
    eprintln!(
        "services: {:?}",
        services
            .iter()
            .map(|row| (row.name.clone(), row.state.clone()))
            .collect::<Vec<_>>()
    );
    assert_eq!(services.len(), 1, "one service, as the file says");

    // The project list now shows it, with the config path and one service.
    let projects = lab.core.compose_ls(&engine).await.expect("list projects after up");
    let project = projects
        .iter()
        .find(|row| row.name == PROJECT)
        .unwrap_or_else(|| panic!("{PROJECT} is in the list: {projects:?}"));
    assert!(
        project.config_files.contains(PROJECT_DIR),
        "the engine names the file: {project:?}"
    );
    assert_eq!(project.services, 1);
    assert_eq!(project.containers, 1);
    eprintln!(
        "project: {} status={} services={}",
        project.name, project.status, project.services
    );

    // Logs follow on the container stream channel, stopped by the caller.
    let (events, mut lines) = tokio::sync::mpsc::unbounded_channel();
    let (end, mut ends) = tokio::sync::mpsc::unbounded_channel();
    let stream = lab
        .core
        .compose_logs_start(&engine, PROJECT, 50, events, end)
        .await
        .expect("follow the project's logs");
    let mut collected = 0usize;
    let _ = timeout(Duration::from_secs(15), async {
        loop {
            tokio::select! {
                line = lines.recv() => {
                    match line {
                        Some(_) => collected += 1,
                        None => break,
                    }
                }
                _ = ends.recv() => break,
            }
        }
    })
    .await;
    lab.core.container_stream_stop(&stream).await;
    eprintln!("logs: {collected} lines");
    assert!(collected > 0, "a followed compose log delivered something");

    // Down: the containers go away, and the project leaves the engine's list.
    lab.core.compose_down(&engine, PROJECT).await.expect("down the project");
    let projects = lab.core.compose_ls(&engine).await.expect("list projects after down");
    assert!(
        !projects.iter().any(|row| row.name == PROJECT),
        "a project whose containers are gone is not listed: {:?}",
        projects.iter().map(|row| row.name.clone()).collect::<Vec<_>>()
    );

    // The test's own directory leaves with it.
    lab.with_files(async |handle| {
        lab.core
            .delete_entry(handle, PROJECT_DIR, sevenshell_types::EntryKind::Directory)
            .await
            .expect("remove the project directory");
        let listing = lab
            .core
            .list_files(handle, "/root")
            .await
            .expect("list /root after cleanup");
        assert!(
            !listing.entries.iter().any(|entry| entry.name == "mem-compose-test"),
            "the directory the test made is gone"
        );
    })
    .await;

    lab.core.container_disconnect(&engine).await;
}
