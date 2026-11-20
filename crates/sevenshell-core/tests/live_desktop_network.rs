//! The network surface of a real Linux desktop session's Docker engine.
//!
//! Ignored by default: it needs the SSH lab with Docker on the far side.
//!
//! ```text
//! SEVENSHELL_TEST_HOST=host SEVENSHELL_TEST_PORT=22 SEVENSHELL_TEST_USER=root \
//!   SEVENSHELL_TEST_PASSWORD=… cargo test -p sevenshell-core --test live_desktop_network -- --ignored
//! ```
//!
//! Everything this touches is a resource the test makes itself: one network named after the
//! process, and — when an image to attach is already on the engine — one throwaway container for
//! the removal guardrail. Both are gone when the test is. The engine's own fleet is only read.

use std::sync::Arc;

use sevenshell_core::Core;
use sevenshell_types::{
    AuthMethod, ContainerCreateRequest, NetworkCreateRequest, OpenOutcome, Protocol, Session, SessionAuth,
    TerminalSettings,
};
use sevenshell_vault::{SessionSecret, Vault};
use tempfile::{TempDir, tempdir};

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
}

/// A subnet of this test's own, so two runs cannot collide and no real network is touched.
fn test_subnet() -> (String, String) {
    let octet = 30 + (std::process::id() % 200);
    (format!("172.{octet}.0.0/24"), format!("172.{octet}.0.1"))
}

#[tokio::test]
#[ignore = "needs the SSH lab with Docker on the far side"]
async fn a_desktop_engine_lists_creates_and_removes_networks() {
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
    assert!(
        info.network_available,
        "a desktop engine is Docker by construction, so the network surface is there: {info:?}"
    );

    // The engine's own answer: the three networks every Docker engine has.
    let networks = lab.core.network_list(&engine).await.expect("list networks");
    eprintln!("networks: {} rows", networks.len());
    for built_in in ["bridge", "host", "none"] {
        assert!(
            networks.iter().any(|row| row.name == built_in),
            "{built_in} is in the list: {:?}",
            networks.iter().map(|row| row.name.clone()).collect::<Vec<_>>()
        );
    }

    // Create one of the test's own, with a subnet the form would have filled in.
    let (subnet, gateway) = test_subnet();
    let name = format!("mem-net-test-{}", std::process::id());
    lab.core
        .network_create(
            &engine,
            &NetworkCreateRequest {
                name: name.clone(),
                driver: "bridge".to_owned(),
                subnet: subnet.clone(),
                gateway: gateway.clone(),
                ..NetworkCreateRequest::default()
            },
        )
        .await
        .expect("create the test network");

    let networks = lab.core.network_list(&engine).await.expect("list again");
    let created = networks
        .iter()
        .find(|row| row.name == name)
        .unwrap_or_else(|| panic!("the network the test made is in the list: {networks:?}"));
    assert_eq!(created.subnet, subnet, "the inspect filled the subnet in");
    assert_eq!(created.gateway, gateway, "the inspect filled the gateway in");
    assert_eq!(created.containers, 0, "nothing is attached yet");
    eprintln!("created: {name} subnet={subnet} driver={}", created.driver);

    // The removal guardrail, live: an attached container is a refusal with its own code, and the
    // network is still there afterwards. Any small image already on the engine serves as the
    // guard; if none is, the leg is covered by the unit tests instead of a pull.
    let images = lab.core.container_images(&engine).await.expect("list images");
    let guard_image = images
        .iter()
        .find(|row| row.repository == "busybox")
        .or_else(|| images.iter().find(|row| row.repository == "nginx"));
    if let Some(image) = guard_image {
        let tag = format!("{}:{}", image.repository, image.tag);
        let container = format!("mem-net-guard-{}", std::process::id());
        lab.core
            .container_create(
                &engine,
                &ContainerCreateRequest {
                    image: tag.clone(),
                    name: container.clone(),
                    networks: vec![name.clone()],
                    command: "sleep 300".to_owned(),
                    ..ContainerCreateRequest::default()
                },
            )
            .await
            .expect("create the guard container");

        let refusal = lab
            .core
            .network_remove(&engine, &name)
            .await
            .expect_err("a network with containers attached is refused");
        assert_eq!(
            refusal.code(),
            sevenshell_error::ErrorCode::ContainerNetworkInUse,
            "the guardrail's own code: {refusal:?}"
        );
        eprintln!("guardrail refused with: {}", refusal.detail().unwrap_or_default());

        let containers = lab.core.container_list(&engine).await.expect("list containers");
        let guard = containers
            .iter()
            .find(|row| row.name == container)
            .expect("the guard container is in the fleet");
        // A running container leaves in two steps, exactly as the interface offers them.
        lab.core
            .container_action(&engine, &guard.id, "stop", true)
            .await
            .expect("stop the guard container");
        lab.core
            .container_action(&engine, &guard.id, "remove", true)
            .await
            .expect("remove the guard container");
    } else {
        eprintln!("no busybox on the engine; the guardrail's live leg is covered by the unit tests");
    }

    // An empty network leaves when asked, and is gone from the list.
    lab.core
        .network_remove(&engine, &name)
        .await
        .expect("remove the empty network");
    let networks = lab.core.network_list(&engine).await.expect("list after removal");
    assert!(
        !networks.iter().any(|row| row.name == name),
        "the network the test made is gone: {:?}",
        networks.iter().map(|row| row.name.clone()).collect::<Vec<_>>()
    );

    lab.core.container_disconnect(&engine).await;
}
