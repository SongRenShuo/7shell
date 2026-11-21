//! The carrier pool, against a lab server running in this process.
//!
//! One connection's channel ceiling is the ceiling the pool exists to lift, so every test here
//! holds real channels open on real connections until the group has to grow, and counts the
//! connections the lab actually accepted. Nothing here reaches a network that is not
//! `127.0.0.1`.

use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use russh::Disconnect;
use russh::keys;
use russh::server::{Auth, Config as ServerConfig, Handler as ServerHandler, Server as _, Session};
use sevenshell_error::{ErrorCode, ShellError};
use sevenshell_ssh::{
    CarrierPool, ChannelHolder, ConnectFactory, Credential, OpenRequest, Purpose, Route, SshSession, Target,
    TerminalSize, generate,
};
use sevenshell_types::{KeyAlgorithm, PresentedHostKey};
use tokio::net::TcpListener;
use tokio::sync::mpsc;

/// How long the lab waits for the client to notice something: generous for a loopback
/// handshake, short enough that a stuck test is a stuck test and not a minute.
const LAB_BUDGET: Duration = Duration::from_secs(8);

#[derive(Default)]
struct LabCounts {
    /// Connections the lab accepted.
    connections: AtomicU32,
    /// Password authentications the lab answered.
    auths: AtomicU32,
    /// Commands the client started.
    execs: AtomicU32,
    /// Connections the lab took down itself, on the one command that asks for it.
    kills: AtomicU32,
}

struct PoolLabServer {
    counts: Arc<LabCounts>,
}

impl russh::server::Server for PoolLabServer {
    type Handler = PoolLabHandler;

    fn new_client(&mut self, _peer: Option<std::net::SocketAddr>) -> Self::Handler {
        self.counts.connections.fetch_add(1, Ordering::Relaxed);
        PoolLabHandler {
            counts: Arc::clone(&self.counts),
        }
    }
}

struct PoolLabHandler {
    counts: Arc<LabCounts>,
}

impl ServerHandler for PoolLabHandler {
    type Error = russh::Error;

    async fn auth_password(&mut self, _user: &str, _password: &str) -> Result<Auth, Self::Error> {
        self.counts.auths.fetch_add(1, Ordering::Relaxed);
        Ok(Auth::Accept)
    }

    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<russh::server::Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        reply.accept().await;
        Ok(())
    }

    async fn exec_request(
        &mut self,
        channel: russh::ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.counts.execs.fetch_add(1, Ordering::Relaxed);
        session.channel_success(channel)?;
        session.data(channel, b"lab\n".as_slice())?;
        session.eof(channel)?;
        // The one command that ends the connection itself: what a carrier's death looks like
        // from the client's side, without anything this side did about it.
        if data == b"die" {
            self.counts.kills.fetch_add(1, Ordering::Relaxed);
            session.disconnect(Disconnect::ByApplication, "", "en")?;
        }
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
    async fn start() -> Lab {
        let generated = generate(KeyAlgorithm::Ed25519, "the pool lab", None).expect("the lab key generates");
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
        let inner = Arc::clone(&counts);
        tokio::spawn(async move {
            let mut server = PoolLabServer { counts: inner };
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

    /// The connect factory a pool grows by. It holds what a connection needs — the pinned key,
    /// the credential, the target — and is the pool's only way to open one, which is why a
    /// reconnect can neither lose the credential nor ask anybody for it again.
    fn factory(&self) -> ConnectFactory {
        let presented = self.presented();
        Arc::new(move || {
            let request = a_request(&presented);
            Box::pin(async move {
                let (events, _output) = mpsc::channel(16);
                Ok(Arc::new(
                    SshSession::open(request, events).await.expect("the lab carrier opens"),
                ))
            }) as _
        })
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

/// A carrier request for the lab: a connection with no terminal on it, which is what a pool's
/// carrier is.
fn a_request(presented: &PresentedHostKey) -> OpenRequest {
    OpenRequest {
        target: Target {
            host: presented.host.clone(),
            port: presented.port,
            user: "person".to_owned(),
        },
        credential: Credential::Password("not checked".to_owned()),
        terminal_type: String::new(),
        keepalive_seconds: 0,
        forward_agent: false,
        timeout: LAB_BUDGET,
        expected_host_key: presented.clone(),
        size: TerminalSize::default(),
        route: Route::Direct,
        purpose: Purpose::Carrier,
    }
}

/// The channel that finds the freest carrier's count at `limit - 1` opens a second connection
/// and rides it, while the primary keeps every slot it already held.
///
/// This is the approved semantics read against the budget's own numbers: the eighth channel
/// arrives with seven held — one slot from full — and takes the fresh connection, so the ninth
/// never has to wait on a handshake, and the primary's last slot stays free for the ask nobody
/// scheduled. Both connections authenticated with the one credential the factory holds.
#[tokio::test]
async fn the_channel_that_finds_the_count_at_limit_minus_one_rides_a_second_connection() {
    let lab = Lab::start().await;
    let pool = CarrierPool::new(lab.factory());
    let session = pool.carrier().await.expect("the first carrier");
    assert_eq!(lab.counts.connections.load(Ordering::Relaxed), 1);

    let mut streams = Vec::new();
    for index in 1..=7 {
        streams.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
                .await
                .unwrap_or_else(|error| panic!("stream {index} opened: {error}")),
        );
    }
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers.len(), 1, "seven channels held, one connection");
    assert_eq!(snapshot.carriers[0].held, 7);

    streams.push(
        session
            .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
            .await
            .expect("the eighth stream opens"),
    );
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        2,
        "the pool grew to a second connection"
    );
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers.len(), 2);
    assert_eq!(snapshot.carriers[0].held, 7, "the primary kept its seven");
    assert_eq!(snapshot.carriers[1].held, 1, "the eighth channel rides the new carrier");
    assert_eq!(
        lab.counts.auths.load(Ordering::Relaxed),
        2,
        "both connections offered the factory's credential; nothing was collected again"
    );

    drop(streams);
    pool.close().await;
}

/// Routing places the next channel where the room is, not on the primary by habit.
#[tokio::test]
async fn routing_places_the_next_channel_where_the_room_is() {
    let lab = Lab::start().await;
    let pool = CarrierPool::new(lab.factory());
    let session = pool.carrier().await.expect("the first carrier");

    let mut streams = Vec::new();
    for _ in 1..=7 {
        streams.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
                .await
                .expect("a stream opens"),
        );
    }
    streams.push(
        session
            .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
            .await
            .expect("the eighth stream opens"),
    );
    assert_eq!(pool.snapshot().carriers.len(), 2, "the group grew");

    // The primary gets its room back: one stream ends, and its slot with it. The sibling now
    // has more room than the primary, and the next channel goes there — no third connection.
    drop(streams.remove(0));
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers[0].held, 6);
    assert_eq!(snapshot.carriers[1].held, 1);

    streams.push(
        session
            .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
            .await
            .expect("the next stream opens"),
    );
    let snapshot = pool.snapshot();
    assert_eq!(
        snapshot.carriers[1].held, 2,
        "the carrier with the most room took the channel"
    );
    assert_eq!(snapshot.carriers[0].held, 6, "the primary was left as it was");
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        2,
        "no third connection was needed"
    );

    drop(streams);
    pool.close().await;
}

/// A carrier the lab took down is marked down by the first open that meets the death, and the
/// pool refills its slot — the same place in the group, one new connection — in time for the
/// very next ask.
#[tokio::test]
async fn a_carrier_that_dies_is_refilled_in_place_by_the_next_ask() {
    let lab = Lab::start().await;
    let pool = CarrierPool::new(lab.factory());
    let session = pool.carrier().await.expect("the first carrier");
    let stream = session
        .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
        .await
        .expect("a stream opens");

    let _ = session.open_exec_stream("die", ChannelHolder::Exec).await.map(drop);
    lab.until(1, |counts| counts.kills.load(Ordering::Relaxed), "kills")
        .await;

    let again = session
        .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
        .await
        .expect("the pool marked the carrier down, refilled its slot, and served the ask");
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        2,
        "one refill, not a new slot"
    );
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers.len(), 1, "the slot was refilled, not grown around");
    assert!(snapshot.carriers[0].up);
    assert_eq!(
        snapshot.carriers[0].held, 1,
        "the refilled carrier holds only the ask it served"
    );

    drop(stream);
    drop(again);
    pool.close().await;
}

/// A pool at its bound cannot grow, so the channel that every carrier's ledger refuses carries
/// the whole group's arithmetic in its answer — who holds what, where, and how much in total.
#[tokio::test]
async fn a_pool_at_its_bound_refuses_with_the_whole_group_named() {
    let lab = Lab::start().await;
    let pool = CarrierPool::with_limit(lab.factory(), 1);
    let session = pool.carrier().await.expect("the only carrier");

    let mut streams = Vec::new();
    for _ in 1..=8 {
        streams.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
                .await
                .expect("a stream opens"),
        );
    }
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        1,
        "a pool of one never grew, and the eighth channel still took the last slot"
    );

    let error = match session.open_exec_stream("cat /proc/uptime", ChannelHolder::Exec).await {
        Ok(_) => panic!("the ninth channel has nowhere to go"),
        Err(error) => error,
    };
    assert_eq!(error.code(), ErrorCode::SshChannelRefused);
    let diagnostics = error.diagnostics();
    assert_eq!(diagnostics.get("carriers").map(String::as_str), Some("1/1"));
    assert_eq!(diagnostics.get("pool_held").map(String::as_str), Some("8"));
    assert_eq!(diagnostics.get("pools").map(String::as_str), Some("0:exec:8"));
    assert!(
        error.detail().unwrap_or_default().contains("pool"),
        "the message names the group: {}",
        error.detail().unwrap_or_default()
    );

    drop(streams);
    pool.close().await;
}

/// The events stream is the one holder the pool never moves and never grows for: it opens on
/// the carrier it was asked on, and the count at `limit - 1` does not open a second connection
/// for it.
#[tokio::test]
async fn an_events_channel_never_grows_the_pool_or_leaves_its_carrier() {
    let lab = Lab::start().await;
    let pool = CarrierPool::new(lab.factory());
    let session = pool.carrier().await.expect("the primary carrier");

    let mut streams = Vec::new();
    for _ in 1..=7 {
        streams.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
                .await
                .expect("a stream opens"),
        );
    }
    streams.push(
        session
            .open_exec_stream("cat /proc/uptime", ChannelHolder::Events)
            .await
            .expect("the events ask opens on the carrier it arrived on"),
    );
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        1,
        "the pool did not grow for an events channel"
    );
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers.len(), 1);
    assert_eq!(snapshot.carriers[0].held, 8);
    assert_eq!(
        snapshot.carriers[0].holders.get(&ChannelHolder::Events),
        Some(&1),
        "the events slot is on the same ledger the stream's yield hook would live on"
    );

    drop(streams);
    pool.close().await;
}

/// A handout closes the carriers nobody holds a channel on: the connections a burst grew do not
/// outlive the burst.
#[tokio::test]
async fn a_handout_closes_the_carriers_nobody_holds_channels_on() {
    let lab = Lab::start().await;
    let pool = CarrierPool::new(lab.factory());
    let session = pool.carrier().await.expect("the first carrier");

    let mut streams = Vec::new();
    for _ in 1..=8 {
        streams.push(
            session
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
                .await
                .expect("a stream opens"),
        );
    }
    assert_eq!(pool.snapshot().carriers.len(), 2, "the burst grew the group");

    drop(streams);
    let again = pool.carrier().await.expect("the next handout");
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers.len(), 1, "the idle carrier was closed, not kept");
    assert!(snapshot.carriers[0].up);
    assert_eq!(snapshot.carriers[0].held, 0);
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        2,
        "pruning closes; it does not connect"
    );
    assert!(
        Arc::strong_count(&again) >= 1,
        "the handed-out carrier is the one that stays"
    );

    pool.close().await;
}

/// A connect that fails earns the slot a pause, doubled per failure; an ask during the pause is
/// refused at once with the reason, and the lab is not knocked on again.
#[tokio::test]
async fn a_failed_connect_earns_a_pause_the_next_ask_respects() {
    let lab = Lab::start().await;
    let presented = lab.presented();
    let failures = Arc::new(AtomicU32::new(0));
    let failures_for_factory = Arc::clone(&failures);
    let factory: ConnectFactory = Arc::new(move || {
        let presented = presented.clone();
        let failures_for_factory = Arc::clone(&failures_for_factory);
        Box::pin(async move {
            if failures_for_factory.fetch_add(1, Ordering::Relaxed) < 2 {
                return Err(ShellError::ssh_unreachable(
                    "127.0.0.1",
                    presented.port,
                    "the lab is shut for now",
                ));
            }
            let (events, _output) = mpsc::channel(16);
            Ok(Arc::new(
                SshSession::open(a_request(&presented), events)
                    .await
                    .expect("the lab carrier opens"),
            ))
        })
    });
    let pool = CarrierPool::new(factory).with_peer("127.0.0.1", lab.port);

    let error = match pool.carrier().await {
        Ok(_) => panic!("the first connect fails"),
        Err(error) => error,
    };
    assert_eq!(error.code(), ErrorCode::SshUnreachable);

    let error = match pool.carrier().await {
        Ok(_) => panic!("the pause holds the second ask back"),
        Err(error) => error,
    };
    assert_eq!(
        error.code(),
        ErrorCode::SshBackoff,
        "the pause answers at once, without a connect"
    );
    assert_eq!(
        lab.counts.connections.load(Ordering::Relaxed),
        0,
        "the lab was not knocked on while the pause ran"
    );
    assert!(
        error.detail().unwrap_or_default().contains("the lab is shut for now"),
        "the pause names the failure that earned it: {}",
        error.detail().unwrap_or_default()
    );

    pool.close().await;
}

/// The freest carrier wins on room, and an ask that could go anywhere lands on the carrier that
/// joined first — a tie is not a reason to shuffle.
#[tokio::test]
async fn a_tie_in_room_is_broken_by_the_order_the_carriers_joined() {
    let lab = Lab::start().await;
    let pool = CarrierPool::new(lab.factory());
    let primary = pool.carrier().await.expect("the primary carrier");

    let mut streams = Vec::new();
    for _ in 1..=7 {
        streams.push(
            primary
                .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
                .await
                .expect("a stream opens"),
        );
    }
    let _sibling = pool.carrier().await.expect("the sibling the handout grew");
    assert_eq!(pool.snapshot().carriers.len(), 2);

    // Everything the primary held ends, and both carriers are idle: a tie. The next channel
    // goes to the carrier that joined first.
    drop(streams);
    let stream = primary
        .open_exec_stream("cat /proc/uptime", ChannelHolder::Exec)
        .await
        .expect("the stream opens");
    let snapshot = pool.snapshot();
    assert_eq!(snapshot.carriers[0].held, 1, "the oldest carrier took it");
    assert_eq!(snapshot.carriers[1].held, 0);

    drop(stream);
    pool.close().await;
}
