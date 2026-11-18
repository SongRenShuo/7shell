//! A remote forward — the `ssh -R` shape — against a real server.
//!
//! Ignored by default: it needs a running sshd with the account a person would use.
//!
//! ```text
//! SEVENSHELL_TEST_HOST=host SEVENSHELL_TEST_PORT=22 SEVENSHELL_TEST_USER=root \
//!   SEVENSHELL_TEST_PASSWORD=… cargo test -p sevenshell-core --test live_remote_forward -- --ignored --nocapture
//! ```
//!
//! The unit tests prove the policy verdict and the bridge against local sockets; what only a live
//! host can show is that the server really binds the port — a zero asked *it* for a free one, and
//! the answer it chose is the one worth reading back — that a connection the server accepts is
//! dialled back to this machine and answered, and that the stop takes the far side's listener down
//! with it rather than leaving a port open behind an interface that says the forward is gone.
//!
//! The target here is a tiny HTTP responder the test binds on this machine's loopback, so the run
//! does not depend on a separate web host being up; the port it uses is whichever the system chose.
//! A `curl` on the far side is the question, and `200` is the answer. Read-only and reversible:
//! nothing is written to the far side, and the only thing the server holds is the one listener the
//! test asks for and then cancels.
//!
//! A remote forward is the one kind whose policy verdict is always `Destructive`, so the runtime
//! open stops for a person on every matrix — a destructive verdict is never looser than a person.
//! The open here carries `acknowledged: true`, which is the test standing in for the person the
//! forwards window's confirmation would have asked.

use std::sync::Arc;
use std::time::Duration;

use sevenshell_core::Core;
use sevenshell_ssh::{Credential, OpenRequest, Purpose, Route, SshSession, Target, TerminalSize, probe_host_key};
use sevenshell_types::{
    AuthMethod, ForwardMode, LocalForward, OpenOutcome, Protocol, Session, SessionAuth, TerminalSettings,
};
use sevenshell_vault::{SessionSecret, Vault};
use tempfile::{TempDir, tempdir};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

const OPEN_TIMEOUT: Duration = Duration::from_secs(20);
const RUN_TIMEOUT: Duration = Duration::from_secs(30);

struct Lab {
    /// Owned so the vault file outlives the test.
    _directory: TempDir,
    core: Arc<Core>,
    session_id: String,
    /// A second connection of its own, for the commands the far side runs — the carrier carries
    /// channels, not execs, and the core does not hand its sessions out.
    observer: Arc<SshSession>,
    /// Kept alive so the terminal's output has somewhere to go.
    _events: mpsc::Receiver<sevenshell_core::CoreEvent>,
}

fn environment(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.trim().is_empty())
}

async fn lab() -> Option<Lab> {
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
        id: "lab-remote-forward".to_owned(),
        name: "lab remote forward".to_owned(),
        group_id: None,
        protocol: Protocol::Ssh,
        host: host.clone(),
        port,
        user: user.clone(),
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
        .save_session(session, Some(SessionSecret::Password(password.clone())))
        .expect("save");

    let (core, events) = Core::new(vault);

    let observer = {
        let target = Target {
            host: host.clone(),
            port,
            user: user.clone(),
        };
        let presented = probe_host_key(&target.host, target.port, OPEN_TIMEOUT)
            .await
            .expect("probe the host key");
        let request = OpenRequest {
            target,
            credential: Credential::Password(password.clone()),
            terminal_type: String::new(),
            keepalive_seconds: 0,
            forward_agent: false,
            timeout: OPEN_TIMEOUT,
            expected_host_key: presented,
            size: TerminalSize::default(),
            route: Route::Direct,
            purpose: Purpose::Carrier,
        };
        let (observer_events, _unused) = mpsc::channel(1);
        SshSession::open(request, observer_events)
            .await
            .expect("the observer connection opens")
    };

    Some(Lab {
        _directory: directory,
        core,
        session_id: "lab-remote-forward".to_owned(),
        observer: Arc::new(observer),
        _events: events,
    })
}

impl Lab {
    /// Opens the terminal, trusting whatever key it is asked about — what a person does once.
    async fn open_trusting_everything(&self) -> String {
        for _ in 0..4 {
            match self.core.open_terminal(&self.session_id).await.expect("open") {
                OpenOutcome::Opened { handle, .. } => return handle,
                OpenOutcome::HostKeyUnknown { key } => self.core.trust_host_key(&key).expect("trust"),
                other => panic!("expected the terminal to open, got {other:?}"),
            }
        }
        panic!("the route never finished asking");
    }

    /// Runs one command on the far side, through the observer connection.
    async fn exec(&self, command: &str) -> sevenshell_ssh::ExecOutcome {
        self.observer
            .exec(command, RUN_TIMEOUT)
            .await
            .unwrap_or_else(|error| panic!("the command {command:?} runs: {error}"))
    }
}

/// An HTTP server that answers every connection with `200` and two bytes of body.
///
/// Bound here rather than borrowed from another process: the test's question is "did the far side
/// reach this machine", and a responder of its own is the one answer that cannot be blamed on a
/// host that happened to be down.
async fn start_responder() -> (u16, tokio::task::JoinHandle<()>) {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("a loopback port for the responder");
    let port = listener.local_addr().expect("the responder's address").port();
    let answer = "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok";

    let task = tokio::spawn(async move {
        let answer = answer;
        while let Ok((mut socket, _)) = listener.accept().await {
            let mut buffer = [0u8; 1024];
            // The request line is read and discarded: what matters is what goes back.
            let _ = socket.read(&mut buffer).await;
            let _ = socket.write_all(answer.as_bytes()).await;
        }
    });
    (port, task)
}

#[tokio::test]
#[ignore = "needs the SSH lab: set SEVENSHELL_TEST_HOST/PORT/USER/PASSWORD"]
async fn a_remote_forward_reaches_this_machine_from_the_far_side_and_stops_with_the_tunnel() {
    let Some(lab) = lab().await else {
        return;
    };
    let _handle = lab.open_trusting_everything().await;

    let (responder_port, _responder) = start_responder().await;
    eprintln!("the responder answers on 127.0.0.1:{responder_port}");

    let before = lab.core.tunnels().await.len();
    let request = LocalForward {
        id: String::new(),
        // Loopback on the server, and zero asks *it* for a free port. Nothing here asks the server
        // to bind an address its neighbours could reach.
        bind_host: "127.0.0.1".to_owned(),
        bind_port: 0,
        mode: ForwardMode::Remote,
        target_host: "127.0.0.1".to_owned(),
        target_port: responder_port,
    };

    let open = lab
        .core
        .tunnel_open(&lab.session_id, request, true)
        .await
        .expect("the remote forward opens");
    assert!(open.id.starts_with("runtime-"), "the registry named it: {}", open.id);
    assert!(open.bind_port > 0, "the server chose the port: {}", open.bind_port);
    assert_eq!(open.bind_host, "127.0.0.1", "the far side's bind is what reads back");
    assert_eq!(open.mode, ForwardMode::Remote);
    assert_eq!(lab.core.tunnels().await.len(), before + 1, "the registry grew by one");
    eprintln!("remote forward up: the server listens on 127.0.0.1:{}", open.bind_port);

    // The question from the far side, and the answer through the tunnel to this machine's
    // responder: `200` is the whole proof that the bridge dials.
    let answer = lab
        .exec(&format!(
            "curl -s -o /dev/null -w '%{{http_code}}' --max-time 8 http://127.0.0.1:{}/",
            open.bind_port
        ))
        .await;
    assert_eq!(answer.exit_code, Some(0), "curl ran: {}", answer.stderr);
    assert_eq!(answer.stdout.trim(), "200", "the far side reached this machine");
    eprintln!("through the tunnel: HTTP {}", answer.stdout.trim());

    lab.core
        .tunnel_runtime_stop(&open.id)
        .await
        .expect("the remote forward stops");
    assert_eq!(lab.core.tunnels().await.len(), before, "the registry is as it was");

    // The stop is not only local: the server's listener went down with the tunnel, and the same
    // curl that answered `200` now finds nothing there.
    let after = lab
        .exec(&format!(
            "curl -s -o /dev/null -w '%{{http_code}}' --max-time 8 http://127.0.0.1:{}/",
            open.bind_port
        ))
        .await;
    eprintln!(
        "after the stop: exit={:?} http={}",
        after.exit_code,
        after.stdout.trim()
    );
    assert_ne!(after.stdout.trim(), "200", "the server's listener went down with the tunnel");
}
