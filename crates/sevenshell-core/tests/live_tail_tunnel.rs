//! What a real host gives a runtime forward and a followed file, over a real connection.
//!
//! Ignored by default: it needs a running sshd with the account a person would use.
//!
//! ```text
//! SEVENSHELL_TEST_HOST=host SEVENSHELL_TEST_PORT=22 SEVENSHELL_TEST_USER=root \
//!   SEVENSHELL_TEST_PASSWORD=… cargo test -p sevenshell-core --test live_tail_tunnel -- --ignored
//! ```
//!
//! The unit tests prove the command a tail builds and the gates in front of it; what only a live
//! host can show is that `tail -F` really streams an existing log's lines back through the carrier,
//! that the stop ends the stream on both sides, and that a forward opened at runtime — loopback,
//! a port the system chooses — answers a TCP connect on this machine and reaches sshd on the far
//! side before the stop takes the listener down. Read-only and reversible, all of it: nothing is
//! written to the far side, and the only thing bound is a loopback port.

use std::sync::Arc;
use std::time::Duration;

use sevenshell_core::Core;
use sevenshell_types::{
    AuthMethod, ForwardMode, LocalForward, OpenOutcome, Protocol, Session, SessionAuth, TailStreamLine,
    TerminalSettings,
};
use sevenshell_vault::{SessionSecret, Vault};
use tempfile::{TempDir, tempdir};
use tokio::io::AsyncReadExt;
use tokio::sync::mpsc;

struct Lab {
    /// Owned so the vault file outlives the test.
    _directory: TempDir,
    core: Arc<Core>,
    session_id: String,
    /// Kept alive so the terminal's output has somewhere to go; the tail never reads it.
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
        id: "lab-tail-tunnel".to_owned(),
        name: "lab tail and tunnel".to_owned(),
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
        session_id: "lab-tail-tunnel".to_owned(),
        _events: events,
    })
}

impl Lab {
    /// Opens the terminal, trusting whatever key it is asked about — what a person does once.
    ///
    /// The tail and the forward ride this session's carrier; opening the terminal first is what
    /// makes the carrier shared, the way a desktop session holds one.
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
}

/// Reads one line a tail sent, waiting at most the timeout for it.
async fn next_line(lines: &mut mpsc::UnboundedReceiver<TailStreamLine>) -> Option<TailStreamLine> {
    tokio::time::timeout(Duration::from_secs(10), lines.recv())
        .await
        .ok()
        .flatten()
}

/// Follows `path` and answers how many lines arrived inside the window.
///
/// `tail -F` prints the backlog first, so a file with content answers at once; a file that is
/// empty answers with nothing, which is the caller's cue to try another one.
async fn count_lines_followed(
    lab: &Lab,
    path: &str,
    reads: usize,
) -> (
    String,
    usize,
    mpsc::UnboundedReceiver<TailStreamLine>,
    mpsc::UnboundedReceiver<sevenshell_types::TailStreamEnd>,
) {
    let (events, mut lines) = mpsc::unbounded_channel();
    let (end, ends) = mpsc::unbounded_channel();
    let tail_id = lab
        .core
        .file_tail_open(&lab.session_id, path, 50, events, end)
        .await
        .unwrap_or_else(|error| panic!("the tail of {path} opens: {error}"));

    let mut seen = 0;
    for _ in 0..reads {
        match next_line(&mut lines).await {
            Some(line) => {
                seen += 1;
                eprintln!("{path}: {}", line.line);
            }
            None => break,
        }
    }
    (tail_id, seen, lines, ends)
}

#[tokio::test]
#[ignore = "needs the SSH lab: see deploy/lab/README.md"]
async fn a_followed_log_streams_lines_and_a_runtime_forward_answers_a_connect() {
    let Some(lab) = lab() else {
        return;
    };
    let _handle = lab.open_trusting_everything().await;

    // -- the file it follows -------------------------------------------------
    //
    // The security log is written every few minutes, and `tail -n 50 -F` prints what is already
    // there before it follows, so lines arrive at once. A log that happens to be empty right now
    // falls back to syslog, which is never quiet for long.
    let (tail_id, seen, _lines, ends) = count_lines_followed(&lab, "/var/log/mofang-security.log", 3).await;
    let mut ends = if seen == 0 {
        lab.core.file_tail_close(&tail_id).await.expect("the quiet tail closes");
        let (tail_id, seen, _lines, ends) = count_lines_followed(&lab, "/var/log/syslog", 3).await;
        assert!(seen > 0, "neither mofang-security.log nor syslog gave a line");
        lab.core
            .file_tail_close(&tail_id)
            .await
            .expect("the syslog tail closes");
        ends
    } else {
        lab.core.file_tail_close(&tail_id).await.expect("the tail closes");
        ends
    };

    // The stop reaches the far side: the command's channel closes, and the stream ends.
    let ended = tokio::time::timeout(Duration::from_secs(10), ends.recv()).await;
    assert!(ended.is_ok(), "the tail sends its end after the close");
    eprintln!("tail end: {:?}", ended.expect("the end arrived"));

    // -- the forward it opens at runtime ------------------------------------
    let before = lab.core.tunnels().await.len();
    let request = LocalForward {
        id: String::new(),
        // Loopback only, and port zero asks the system for a free one. This test never binds an
        // address another machine could reach.
        bind_host: "127.0.0.1".to_owned(),
        bind_port: 0,
        mode: ForwardMode::Local,
        target_host: "127.0.0.1".to_owned(),
        target_port: 22,
    };

    let open = lab
        .core
        .tunnel_open(&lab.session_id, request)
        .await
        .expect("the runtime forward opens");
    assert!(open.id.starts_with("runtime-"), "the registry named it: {}", open.id);
    assert!(open.bind_port > 0, "the system chose a port: {}", open.bind_port);
    assert_eq!(open.bind_host, "127.0.0.1");
    assert_eq!(lab.core.tunnels().await.len(), before + 1, "the registry grew by one");
    eprintln!(
        "tunnel up: {} -> {}:{}",
        open.bind_port, open.target_host, open.target_port
    );

    // The bound port answers a TCP connect on this machine, and what greets us is sshd on the
    // far side — the tunnel carries, it does not merely listen.
    let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", open.bind_port))
        .await
        .expect("the listener answers a connect");
    let mut banner = vec![0u8; 8];
    let read = tokio::time::timeout(Duration::from_secs(10), stream.read(&mut banner))
        .await
        .expect("the banner arrives within ten seconds")
        .expect("the banner reads");
    let banner = String::from_utf8_lossy(&banner[..read]).into_owned();
    assert!(banner.starts_with("SSH-"), "the far side is sshd: {banner}");
    eprintln!("through the tunnel: {banner}");
    drop(stream);

    lab.core
        .tunnel_runtime_stop(&open.id)
        .await
        .expect("the runtime forward stops");
    assert_eq!(lab.core.tunnels().await.len(), before, "the registry is as it was");

    // Stopping the same forward again names the id instead of pretending something was stopped.
    let error = lab
        .core
        .tunnel_runtime_stop(&open.id)
        .await
        .expect_err("the second stop says so");
    eprintln!("second stop: {error:?}");
}
