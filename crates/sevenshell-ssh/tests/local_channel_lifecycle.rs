//! The channel lifecycle, against a lab server running in this process.
//!
//! The two failures behind the "no more sessions" outage are both about what happens to a
//! channel *this side* opened and then stopped reading: a command that outlives its budget (a
//! `df` on a hung mount is the usual one) leaves the channel open on the server unless this side
//! sends Close, and a server refusing the channel open has to be answered with an error that
//! says the connection's session slots are full — not a generic channel failure that a sampling
//! loop would meet again on its next tick, forever.
//!
//! The lab is a real `russh` server on a loopback port of this machine: it authenticates any
//! password, accepts or refuses session channels as the test asks, and records what it was
//! told about every channel it opened. Nothing here reaches a network that is not `127.0.0.1`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use russh::keys;
use russh::server::{Auth, Config as ServerConfig, Handler as ServerHandler, Server as _, Session};
use sevenshell_error::ErrorCode;
use sevenshell_ssh::{
    ChannelHolder, Credential, OpenRequest, Purpose, Route, SshSession, Target, TerminalSize, generate,
};
use sevenshell_types::{KeyAlgorithm, PresentedHostKey};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// How long the lab waits for the client to notice something: generous for a loopback
/// handshake, short enough that a stuck test is a stuck test and not a minute.
const LAB_BUDGET: Duration = Duration::from_secs(8);

/// What the lab does once a command starts on a channel.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Command {
    /// Success, one line of output, end of file, and the channel closes — a command that
    /// finished, which leaves the client nothing to clean up.
    Finishes,
    /// Success, one line of output, end of file, and then the channel stays: a command that
    /// outlives the client's patience. The Close this side owes is what the test looks for.
    Hangs,
}

/// What the lab does when a session channel is asked for.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ChannelOpen {
    Accept,
    /// The channel open is answered with a rejection — what OpenSSH answers with when a
    /// connection's `MaxSessions` is used up.
    Refuse,
}

#[derive(Default)]
struct LabCounts {
    /// Channels the client sent Close for.
    closes: AtomicU32,
    /// Channels the client sent EOF for.
    eofs: AtomicU32,
    /// Channels the server refused to open.
    refusals: AtomicU32,
    /// Commands the client started.
    execs: AtomicU32,
}

struct LabServer {
    counts: Arc<LabCounts>,
    open: ChannelOpen,
    command: Command,
}

impl russh::server::Server for LabServer {
    type Handler = LabHandler;

    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self::Handler {
        LabHandler {
            counts: Arc::clone(&self.counts),
            open: self.open,
            command: self.command,
        }
    }
}

struct LabHandler {
    counts: Arc<LabCounts>,
    open: ChannelOpen,
    command: Command,
}

impl ServerHandler for LabHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        match self.open {
            ChannelOpen::Accept => reply.accept().await,
            // Dropping the handle is the refusal: russh answers `AdministrativelyProhibited`,
            // which is the reason OpenSSH carries "no more sessions" on.
            ChannelOpen::Refuse => {
                self.counts.refusals.fetch_add(1, Ordering::Relaxed);
                drop(reply);
            }
        }
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: russh::ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        _data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.counts.execs.fetch_add(1, Ordering::Relaxed);
        session.channel_success(channel)?;
        session.data(channel, b"lab\n".as_slice())?;
        session.eof(channel)?;
        if self.command == Command::Finishes {
            session.close(channel)?;
        }
        // `Hangs` keeps the channel on purpose: the Close that follows is the client's to send.
        Ok(())
    }

    async fn channel_eof(&mut self, _channel: russh::ChannelId, _session: &mut Session) -> Result<(), Self::Error> {
        self.counts.eofs.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }

    async fn channel_close(&mut self, _channel: russh::ChannelId, _session: &mut Session) -> Result<(), Self::Error> {
        self.counts.closes.fetch_add(1, Ordering::Relaxed);
        Ok(())
    }
}

/// A running lab: its port, the key the client pins, and the counters to assert against.
struct Lab {
    port: u16,
    public_key_blob: String,
    counts: Arc<LabCounts>,
}

impl Lab {
    /// Starts a lab server on a loopback port and answers with what a connection needs.
    ///
    /// The server task is detached for the life of the test; the counters are what survive to
    /// be read. The server and its listener live inside the task, because `run_on_socket`'s
    /// future borrows both — the outer task owns them, so the borrow stays inside it.
    async fn start(open: ChannelOpen, command: Command) -> Lab {
        let generated = generate(KeyAlgorithm::Ed25519, "the lab", None).expect("the lab key generates");
        let private = keys::decode_secret_key(generated.private_text(), None).expect("the lab key decodes");
        let public_key_blob = keys::PublicKeyBase64::public_key_base64(private.public_key());

        let listener = TcpListener::bind("127.0.0.1:0").await.expect("a loopback port");
        let port = listener.local_addr().expect("the bound port").port();

        let config = Arc::new(ServerConfig {
            keys: vec![private],
            inactivity_timeout: None,
            ..ServerConfig::default()
        });
        let counts = Arc::new(LabCounts::default());
        let inner_counts = Arc::clone(&counts);
        tokio::spawn(async move {
            let mut server = LabServer {
                counts: inner_counts,
                open,
                command,
            };
            let running = server.run_on_socket(config, &listener);
            let _ = running.await;
        });

        Lab {
            port,
            public_key_blob,
            counts,
        }
    }

    /// The pinned host key the client checks the lab's key against.
    fn presented(&self) -> PresentedHostKey {
        PresentedHostKey {
            host: "127.0.0.1".to_owned(),
            port: self.port,
            key_type: "ssh-ed25519".to_owned(),
            public_key: self.public_key_blob.clone(),
            fingerprint: "SHA256:lab".to_owned(),
        }
    }

    /// A carrier request: a connection with no terminal on it, which is what a sample rides.
    fn carrier_request(&self) -> OpenRequest {
        OpenRequest {
            target: Target {
                host: "127.0.0.1".to_owned(),
                port: self.port,
                user: "person".to_owned(),
            },
            credential: Credential::Password("not checked".to_owned()),
            terminal_type: String::new(),
            keepalive_seconds: 0,
            forward_agent: false,
            timeout: LAB_BUDGET,
            expected_host_key: self.presented(),
            size: TerminalSize::default(),
            route: Route::Direct,
            purpose: Purpose::Carrier,
        }
    }

    /// Waits until `wanted` of the named event have been seen, or gives up after a budget.
    async fn until(&self, wanted: u32, read: impl Fn(&LabCounts) -> u32, what: &str) -> u32 {
        let deadline = tokio::time::Instant::now() + LAB_BUDGET;
        loop {
            let seen = read(&self.counts);
            if seen >= wanted {
                return seen;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "the lab never saw {wanted} {what}; it saw {seen}"
            );
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
    }
}

/// A carrier session on the lab, dropped at the end of the scope the test gives it.
async fn a_carrier(lab: &Lab) -> SshSession {
    let (events, _output) = mpsc::channel(16);
    SshSession::open(lab.carrier_request(), events)
        .await
        .expect("the lab carrier opens")
}

/// A command whose far side outlives the client's budget has its channel closed by this side.
///
/// This is the sample-timeout leak, reproduced: before the fix the channel was dropped without
/// a Close, and the server held its session slot until the whole connection died — which is how
/// a sampling loop filled OpenSSH's `MaxSessions`.
#[tokio::test]
async fn a_command_that_outlives_its_budget_has_its_channel_closed_by_this_side() {
    let lab = Lab::start(ChannelOpen::Accept, Command::Hangs).await;
    let session = a_carrier(&lab).await;

    let error = session
        .exec("cat /proc/uptime", Duration::from_millis(600))
        .await
        .expect_err("the lab command never ends");
    assert_eq!(error.code(), ErrorCode::SshTimeout);

    // The Close and the EOF are what the server needs to free the session slot. Waiting for
    // them rather than sleeping makes the test about the guarantee, not about the machine's
    // speed.
    lab.until(1, |counts| counts.eofs.load(Ordering::Relaxed), "EOFs").await;
    let closes = lab
        .until(1, |counts| counts.closes.load(Ordering::Relaxed), "closes")
        .await;
    assert_eq!(closes, 1, "one timed-out command owes exactly one Close");
}

/// A command that finishes leaves the closing to the server, and this side sends no Close of
/// its own: the polite end is the protocol's, not an extra packet.
#[tokio::test]
async fn a_command_the_server_ended_is_not_closed_again_by_this_side() {
    let lab = Lab::start(ChannelOpen::Accept, Command::Finishes).await;
    let session = a_carrier(&lab).await;

    let outcome = session
        .exec("cat /proc/uptime", LAB_BUDGET)
        .await
        .expect("the lab command finishes");
    assert_eq!(outcome.exit_code, None, "the lab does not report a status");
    assert_eq!(outcome.stdout, "lab\n");

    // The server's own Close has been seen; the client still reads the channel to its end.
    // No client-initiated EOF or Close belongs on this path — the leak fix is for the ends
    // where the server never got to say Close itself.
    let closes = lab.counts.closes.load(Ordering::Relaxed);
    assert_eq!(closes, 0, "a command the server closed owes this side nothing");
}

/// A server refusing the channel open is answered with the refused-channel code and the
/// session-slot semantics — the answer a caller backs off on, not one it retries into.
#[tokio::test]
async fn a_refused_channel_open_is_answered_with_the_session_slot_semantics() {
    let lab = Lab::start(ChannelOpen::Refuse, Command::Finishes).await;
    let session = a_carrier(&lab).await;

    let error = session
        .exec("cat /proc/uptime", LAB_BUDGET)
        .await
        .expect_err("the lab refuses every channel");
    assert_eq!(error.code(), ErrorCode::SshChannelRefused);
    let detail = error.detail().unwrap_or_default();
    assert!(detail.contains("session slots"), "detail was: {detail}");
    assert_eq!(
        lab.counts.refusals.load(Ordering::Relaxed),
        1,
        "the refusal came from the server, not from this side"
    );
}

/// A held stream is counted under its holder, and the count comes back when the stream ends.
///
/// This is the ledger's whole job: the count has to match the channel's life exactly, or the
/// budget refuses opens the server would have taken.
#[tokio::test]
async fn a_held_stream_is_counted_and_its_slot_comes_back_when_it_ends() {
    let lab = Lab::start(ChannelOpen::Accept, Command::Hangs).await;
    let session = a_carrier(&lab).await;
    assert_eq!(session.channel_budget().held, 0, "an idle connection holds nothing");

    let stream = session
        .open_exec_stream("cat /proc/uptime", ChannelHolder::Logs)
        .await
        .expect("the stream opens");
    let budget = session.channel_budget();
    assert_eq!(budget.held, 1, "the held stream is counted");
    assert_eq!(budget.free, budget.limit - 1);
    assert_eq!(budget.holders.get(&ChannelHolder::Logs), Some(&1));

    // The stream ends the way a stopped log follow ends: the value goes away, and the Close it
    // sends is what the server sees — the slot is the ledger's mirror of that.
    drop(stream);
    lab.until(1, |counts| counts.closes.load(Ordering::Relaxed), "closes")
        .await;
    assert_eq!(session.channel_budget().held, 0, "the ended stream released its slot");

    // The room is real: the next open is taken, not refused.
    let again = session
        .open_exec_stream("cat /proc/uptime", ChannelHolder::Logs)
        .await
        .expect("the room came back");
    assert_eq!(session.channel_budget().held, 1);
    drop(again);
    lab.until(2, |counts| counts.closes.load(Ordering::Relaxed), "closes")
        .await;
}

/// An open that would cross the ceiling is refused by this side, before the server sees it.
///
/// The refusal names the arithmetic (n over the ceiling) and the holders — and the lab's own
/// counter proves the refused ask never reached the wire.
#[tokio::test]
async fn an_open_over_the_ceiling_is_refused_here_and_never_reaches_the_server() {
    let lab = Lab::start(ChannelOpen::Accept, Command::Hangs).await;
    let session = a_carrier(&lab).await;

    let mut streams = Vec::new();
    for _ in 0..session.channel_budget().limit {
        streams.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Logs)
                .await
                .expect("each open under the ceiling"),
        );
    }
    assert_eq!(
        lab.counts.execs.load(Ordering::Relaxed),
        session.channel_budget().limit as u32,
        "the lab started one command per open"
    );

    let error = match session.open_exec_stream("cat /proc/uptime", ChannelHolder::Logs).await {
        Ok(_) => panic!("the ceiling is reached, so this open is refused by the budget"),
        Err(error) => error,
    };
    assert_eq!(error.code(), ErrorCode::SshChannelRefused);
    assert_eq!(
        error.message_params().get("held").map(String::as_str),
        Some("8"),
        "the refusal names how full the connection is: {:?}",
        error.message_params()
    );
    assert_eq!(error.message_params().get("limit").map(String::as_str), Some("8"));
    assert_eq!(
        error.diagnostics().get("holders").map(String::as_str),
        Some("logs:8"),
        "the refusal lists who holds what: {:?}",
        error.diagnostics()
    );
    assert_eq!(
        lab.counts.execs.load(Ordering::Relaxed),
        session.channel_budget().limit as u32,
        "the refused open never reached the server"
    );
    assert_eq!(
        session.channel_budget().held,
        session.channel_budget().limit,
        "the refusal held nothing"
    );

    // The room comes back the moment the streams end.
    drop(streams);
    lab.until(
        session.channel_budget().limit as u32,
        |counts| counts.closes.load(Ordering::Relaxed),
        "closes",
    )
    .await;
    assert_eq!(session.channel_budget().held, 0);
}

/// An exhausted budget yields the events stream first, and the new open takes the freed slot.
///
/// The events stream is the designated yielder: the cheapest thing to lose, and the one most
/// likely to have been open for hours. Its owner registers the stop; the budget runs it, the
/// slot comes back, and what asked for the channel gets it.
#[tokio::test]
async fn an_exhausted_budget_yields_the_events_stream_and_the_new_open_takes_its_slot() {
    let lab = Lab::start(ChannelOpen::Accept, Command::Hangs).await;
    let session = a_carrier(&lab).await;

    let events_stream = session
        .open_exec_stream("docker events --format '{{json .}}'", ChannelHolder::Events)
        .await
        .expect("the events stream opens");
    let mut fillers = Vec::new();
    for _ in 1..session.channel_budget().limit {
        fillers.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Logs)
                .await
                .expect("each filler under the ceiling"),
        );
    }
    assert_eq!(session.channel_budget().free, 0, "the connection is exactly full");

    // The hook is the events stream's own stop: the value goes away, the Close travels, the
    // slot comes back. An `Option` under a mutex because the hook is callable many times and
    // the stream leaves it on the first call.
    let stopped: Arc<std::sync::Mutex<Option<_>>> = Arc::new(std::sync::Mutex::new(Some(events_stream)));
    let hook_stopped = Arc::clone(&stopped);
    session.set_events_yield_hook(Some(Arc::new(move || {
        if let Some(stream) = hook_stopped.lock().expect("not poisoned").take() {
            drop(stream);
        }
        Box::pin(async {})
    })));

    let opened = session
        .open_exec_stream("cat /proc/uptime", ChannelHolder::Logs)
        .await
        .expect("the yield made room");
    assert_eq!(
        stopped.lock().expect("not poisoned").is_none(),
        true,
        "the hook ran and the events stream went"
    );
    let budget = session.channel_budget();
    assert_eq!(budget.held, budget.limit, "the new open took the freed slot");
    assert_eq!(
        budget.holders.get(&ChannelHolder::Events),
        None,
        "the events stream is gone"
    );
    assert_eq!(
        budget.holders.get(&ChannelHolder::Logs),
        Some(&budget.limit),
        "the freed slot went to the new log stream"
    );
    // The yielded stream's Close is the one this side sent so far; the fillers are still held.
    lab.until(1, |counts| counts.closes.load(Ordering::Relaxed), "closes")
        .await;

    // Every stream that ends gives its slot back — the yield's accounting holds to the last one.
    let total_opens = budget.limit as u32;
    drop(opened);
    drop(fillers);
    session.set_events_yield_hook(None);
    lab.until(total_opens, |counts| counts.closes.load(Ordering::Relaxed), "closes")
        .await;
    assert_eq!(session.channel_budget().held, 0);
}
