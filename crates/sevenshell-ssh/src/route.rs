//! Reaching a target through another connection, and answering a local port from one.
//!
//! These are the same primitive twice. A channel opened on an established session behaves like a
//! socket — it is a byte stream to a `host:port` as seen from the far side — so a second SSH
//! connection can run over it, and a listener on this machine can feed bytes into it. That is all
//! a jump host is, and all `ssh -L` is.

use std::future::Future;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use sevenshell_error::ShellError;
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::net::TcpListener;
use tokio::sync::mpsc;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use crate::SshSession;

/// A stream to somewhere: a socket, or a channel inside a connection.
pub trait TunnelStream: AsyncRead + AsyncWrite + Unpin + Send {}

impl<T: AsyncRead + AsyncWrite + Unpin + Send> TunnelStream for T {}

/// A stream whose concrete type a chain of hops makes unknowable at the call site.
pub type BoxedStream = Box<dyn TunnelStream>;

/// How a connection reaches its target.
#[derive(Default)]
pub enum Route {
    /// Straight to the target.
    #[default]
    Direct,
    /// Through an established session, which may itself have been reached through another one.
    Through {
        hop: Arc<SshSession>,
        host: String,
        port: u16,
    },
}

impl std::fmt::Debug for Route {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Direct => f.write_str("Route::Direct"),
            Self::Through { host, port, .. } => write!(f, "Route::Through({host}:{port})"),
        }
    }
}

impl Route {
    /// The sessions this route depends on, in the order they were opened.
    ///
    /// A connection opened over a channel lives exactly as long as the connection that carries it,
    /// so the caller has to hold on to the hops. This is how it knows what to hold.
    pub fn upstream(&self) -> Vec<Arc<SshSession>> {
        match self {
            Self::Direct => Vec::new(),
            Self::Through { hop, .. } => {
                let mut chain = vec![Arc::clone(hop)];
                chain.extend(hop.upstream.iter().cloned());
                chain
            }
        }
    }

    /// What the route is, for a message a person reads.
    pub fn describe(&self) -> Option<String> {
        match self {
            Self::Direct => None,
            Self::Through { host, port, .. } => Some(format!("{host}:{port}")),
        }
    }
}

/// A local port answered from the far side of a connection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalForward {
    pub bind_host: String,
    /// Zero asks the system for a free port, which is what a test or a temporary tunnel wants.
    pub bind_port: u16,
    pub target_host: String,
    pub target_port: u16,
}

/// A forward that is up.
///
/// Dropping this stops nothing: the listener runs on a task of its own, so the only way out is
/// [`TunnelHandle::stop`], and the only way to be sure is to await it.
pub struct TunnelHandle {
    /// What is actually listening. Worth reading back: the caller may have asked for port zero.
    ///
    /// For a remote forward the listener is the far side's, and a port of zero asked the *server*
    /// for a free one — which is why reading it back matters on that side all the more.
    pub listener: SocketAddr,
    connections: Arc<AtomicU64>,
    failures: Arc<AtomicU64>,
    stop: oneshot::Sender<()>,
    task: JoinHandle<()>,
}

impl TunnelHandle {
    /// Connections that were carried to the far side.
    pub fn connections(&self) -> u64 {
        self.connections.load(Ordering::Relaxed)
    }

    /// Connections that could not be carried: the far side refused, or the session ended.
    ///
    /// Counted rather than logged, because it is the one number that explains "the tunnel is up
    /// but nothing works", and a library has no business writing to somebody's log.
    pub fn failures(&self) -> u64 {
        self.failures.load(Ordering::Relaxed)
    }

    /// Stops the listener and waits for it to finish.
    pub async fn stop(self) {
        let _ = self.stop.send(());
        let _ = self.task.await;
    }
}

impl SshSession {
    /// Opens a channel to `host:port` as seen from the far side, as a plain byte stream.
    pub async fn open_tunnel_stream(&self, host: &str, port: u16) -> Result<BoxedStream, ShellError> {
        let channel = self.open_direct_tcpip_channel(host, port).await?;
        Ok(Box::new(channel.into_stream()))
    }

    /// Listens on `forward.bind_host:forward.bind_port` and answers every connection from
    /// `forward.target_host:forward.target_port` on the far side of this session.
    pub async fn forward_local(self: &Arc<Self>, forward: LocalForward) -> Result<TunnelHandle, ShellError> {
        let listener = TcpListener::bind((forward.bind_host.as_str(), forward.bind_port))
            .await
            .map_err(|error| {
                ShellError::app_internal(format!(
                    "the forward could not listen on {}:{}: {error}",
                    forward.bind_host, forward.bind_port
                ))
            })?;

        let bound = listener
            .local_addr()
            .map_err(|error| ShellError::app_internal(format!("the listening address could not be read: {error}")))?;

        let connections = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let (stop, mut stopped) = oneshot::channel();
        let session = Arc::clone(self);

        let counting = Arc::clone(&connections);
        let failing = Arc::clone(&failures);
        let target = forward.clone();

        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted,
                };

                let Ok((mut local, _peer)) = accepted else {
                    // The listener itself is gone; nothing is left to wait for.
                    break;
                };

                let session = Arc::clone(&session);
                let counting = Arc::clone(&counting);
                let failing = Arc::clone(&failing);
                let target = target.clone();

                // Each connection is its own task, so one slow transfer cannot hold up the next
                // connection. A failure is counted: a tunnel that is up but carrying nothing is
                // exactly the state somebody needs explained.
                tokio::spawn(async move {
                    match session
                        .open_tunnel_stream(&target.target_host, target.target_port)
                        .await
                    {
                        Ok(mut remote) => {
                            counting.fetch_add(1, Ordering::Relaxed);
                            if tokio::io::copy_bidirectional(&mut local, &mut remote).await.is_err() {
                                failing.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(_) => {
                            failing.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                });
            }
        });

        Ok(TunnelHandle {
            listener: bound,
            connections,
            failures,
            stop,
            task,
        })
    }

    /// Listens on `forward.bind_host:forward.bind_port` and speaks SOCKS5: every connection says
    /// where it wants to go, and that destination is reached from the far side of this session.
    ///
    /// The listener, the counting and the stopping are the same as a local forward's — a dynamic
    /// forward is one whose destination is decided per connection rather than saved with it, and
    /// nothing else about it is different. Where it does differ is the order of the answers: the
    /// client is told "granted" only after the channel exists, so a destination that cannot be
    /// reached is refused with a reason instead of a connection that dies on first use.
    pub async fn forward_dynamic(self: &Arc<Self>, forward: LocalForward) -> Result<TunnelHandle, ShellError> {
        let listener = TcpListener::bind((forward.bind_host.as_str(), forward.bind_port))
            .await
            .map_err(|error| {
                ShellError::app_internal(format!(
                    "the forward could not listen on {}:{}: {error}",
                    forward.bind_host, forward.bind_port
                ))
            })?;

        let bound = listener
            .local_addr()
            .map_err(|error| ShellError::app_internal(format!("the listening address could not be read: {error}")))?;

        let connections = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let (stop, mut stopped) = oneshot::channel();
        let session = Arc::clone(self);

        let counting = Arc::clone(&connections);
        let failing = Arc::clone(&failures);

        let task = tokio::spawn(async move {
            loop {
                let accepted = tokio::select! {
                    _ = &mut stopped => break,
                    accepted = listener.accept() => accepted,
                };

                let Ok((local, _peer)) = accepted else {
                    break;
                };

                let session = Arc::clone(&session);
                let counting = Arc::clone(&counting);
                let failing = Arc::clone(&failing);

                tokio::spawn(async move {
                    let mut local = local;
                    let request = match crate::socks5::read_request(&mut local).await {
                        Ok(request) => request,
                        Err(_) => {
                            // The refusal has already been written by the handshake.
                            failing.fetch_add(1, Ordering::Relaxed);
                            return;
                        }
                    };

                    let crate::socks5::Request::Connect { host, port } = request;
                    match session.open_tunnel_stream(&host, port).await {
                        Ok(mut remote) => {
                            if crate::socks5::grant(&mut local).await.is_err() {
                                // The client gave up between asking and being told.
                                return;
                            }
                            counting.fetch_add(1, Ordering::Relaxed);
                            if tokio::io::copy_bidirectional(&mut local, &mut remote).await.is_err() {
                                failing.fetch_add(1, Ordering::Relaxed);
                            }
                        }
                        Err(_) => {
                            failing.fetch_add(1, Ordering::Relaxed);
                            crate::socks5::refuse(&mut local, crate::socks5::Refusal::Unreachable).await;
                        }
                    }
                });
            }
        });

        Ok(TunnelHandle {
            listener: bound,
            connections,
            failures,
            stop,
            task,
        })
    }

    /// Asks the far side to listen on `forward.bind_host:forward.bind_port`, and hands every
    /// connection it accepts to `dial`, which reaches the target on this machine's own network.
    ///
    /// This is `ssh -R`: the port that opens is on the *server*, and whoever reaches it there
    /// sees what this machine has at `forward.target_host:forward.target_port`. The listener is
    /// not ours, so this loop has no `accept` — it waits for channels the server opens instead,
    /// which arrive through the connection's handler and are looked up by the port the server
    /// bound. That is also why the handle's `listener` reads back the far side's address: a zero
    /// asked the *server* for a free port, and its answer is the one worth showing.
    ///
    /// Stopping takes the far side's listener down with it. [`TunnelHandle::stop`] awaits the
    /// task, and the task does not end until it has been told `cancel-tcpip-forward` and had its
    /// answer: a server that was listening is not listening once the interface has said the
    /// forward stopped, which is the one state a person reading the forwards list would be misled
    /// by.
    pub async fn forward_remote(
        self: &Arc<Self>,
        forward: LocalForward,
        dial: Arc<dyn RemoteDialer>,
    ) -> Result<TunnelHandle, ShellError> {
        let bound_port = self.request_remote_listen(&forward.bind_host, forward.bind_port).await?;

        let connections = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let (stop, mut stopped) = oneshot::channel();
        let (accepts, mut incoming) = mpsc::channel(REMOTE_ACCEPT_BACKLOG);
        if let Ok(mut slots) = self.remote_accepts.lock() {
            slots.insert(bound_port, accepts);
        }

        let session = Arc::clone(self);
        let counting = Arc::clone(&connections);
        let failing = Arc::clone(&failures);
        let bind_host = forward.bind_host.clone();
        let target_host = forward.target_host.clone();
        let target_port = forward.target_port;

        let task = tokio::spawn(async move {
            loop {
                let next = tokio::select! {
                    _ = &mut stopped => break,
                    next = incoming.recv() => next,
                };
                let Some(channel) = next else {
                    // The hook is gone or the connection ended; nothing is left to wait for.
                    break;
                };

                let dial = Arc::clone(&dial);
                let counting = Arc::clone(&counting);
                let failing = Arc::clone(&failing);
                let target = (target_host.clone(), target_port);

                // Each connection is its own task, the way a local forward's is: one slow transfer
                // cannot hold up the next connection the server accepts.
                tokio::spawn(async move {
                    let incoming: BoxedStream = Box::new(channel.into_stream());
                    bridge_one(incoming, dial, target, &counting, &failing).await;
                });
            }
            // The stop that ended the loop is not the whole stop: the server keeps its port open
            // until it is told, so the round trip happens here, where stopping always passes.
            session.retract_remote_listen(&bind_host, bound_port).await;
            if let Ok(mut slots) = session.remote_accepts.lock() {
                slots.remove(&bound_port);
            }
        });

        Ok(TunnelHandle {
            listener: far_listener(&forward.bind_host, bound_port),
            connections,
            failures,
            stop,
            task,
        })
    }
}

// ---------------------------------------------------------------------------------------------
// The other direction. A local forward listens here and reaches across; a remote forward asks the
// far side to listen and answers from here. The listener, the counting and the stopping are the
// same architecture — what differs is whose machine the listener is on and who dials the target.
// ---------------------------------------------------------------------------------------------

/// How many far-side connections may wait for their bridge before the far side waits for it.
///
/// Bounded on purpose, for the same reason a terminal's output queue is: connections nobody is
/// bridging must not become memory, and a full queue is how the handler learns that its forward
/// stopped.
const REMOTE_ACCEPT_BACKLOG: usize = 16;

/// The future one dial answers with.
pub type RemoteDial = Pin<Box<dyn Future<Output = std::io::Result<BoxedStream>> + Send>>;

/// Opens connections to a target from wherever *this* machine's network is.
///
/// A remote forward's port is on the server, and it is a window onto this machine: every
/// connection the server accepts has to be dialled here. Who can dial — a plain socket today,
/// something else whenever a caller's target is not a socket — is the caller's to say, which is
/// why this is a trait rather than a hard-coded [`TcpStream`]. Called once per connection the far
/// side accepts, so an implementation has to be cheap to call repeatedly and safe from several
/// tasks at once.
pub trait RemoteDialer: Send + Sync + 'static {
    /// Opens one byte stream to `host:port` on this machine's network.
    fn dial(&self, host: String, port: u16) -> RemoteDial;
}

/// The dialer a desktop wires up: the target really is a socket on this machine.
pub struct TcpDialer;

impl RemoteDialer for TcpDialer {
    fn dial(&self, host: String, port: u16) -> RemoteDial {
        Box::pin(async move {
            let stream = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
            stream.set_nodelay(true).ok();
            Ok(Box::new(stream) as BoxedStream)
        })
    }
}

/// Carries one arrived connection across to what the dialer opens.
///
/// Split from the loop above so the bridging can be proved against local sockets: a channel from
/// the far side behaves like a socket, which is why a real one and a test's stand-in read the
/// same. A target that refuses is counted, and the arrived connection is dropped, which closes it
/// on the far side too — what a refused connection does anyway.
async fn bridge_one(
    mut incoming: BoxedStream,
    dial: Arc<dyn RemoteDialer>,
    target: (String, u16),
    connections: &AtomicU64,
    failures: &AtomicU64,
) {
    match dial.dial(target.0, target.1).await {
        Ok(mut remote) => {
            connections.fetch_add(1, Ordering::Relaxed);
            if tokio::io::copy_bidirectional(&mut incoming, &mut remote).await.is_err() {
                failures.fetch_add(1, Ordering::Relaxed);
            }
        }
        Err(_) => {
            failures.fetch_add(1, Ordering::Relaxed);
        }
    }
}

/// The far side's bound address, as the handle reports it.
///
/// A bind host that names no address — `localhost` is the common one — is reported at the loopback
/// it means on the far side; inventing a wider address would be this side claiming to know where
/// the server listens when it does not.
fn far_listener(bind_host: &str, port: u16) -> SocketAddr {
    let host = bind_host.trim();
    let address = match host {
        "localhost" => std::net::Ipv4Addr::LOCALHOST.into(),
        other => other.parse().unwrap_or(std::net::Ipv4Addr::LOCALHOST.into()),
    };
    SocketAddr::new(address, port)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A dialer to one address, for the tests: what the desktop's own dialer is, minus the target
    /// that comes from a forward request.
    struct DialTo(SocketAddr);

    impl RemoteDialer for DialTo {
        fn dial(&self, _host: String, _port: u16) -> RemoteDial {
            let address = self.0;
            Box::pin(async move {
                Ok(Box::new(tokio::net::TcpStream::connect(address).await?) as BoxedStream)
            })
        }
    }

    #[tokio::test]
    async fn a_bridged_connection_carries_bytes_both_ways() {
        let incoming_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a listener");
        let incoming_address = incoming_listener.local_addr().expect("the incoming address");
        let target_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a listener");
        let target_address = target_listener.local_addr().expect("the target address");

        // The target echoes, which is the whole proof of two directions there is.
        tokio::spawn(async move {
            if let Ok((mut socket, _)) = target_listener.accept().await {
                let mut buffer = [0u8; 16];
                if let Ok(read) = socket.read(&mut buffer).await {
                    let _ = socket.write_all(&buffer[..read]).await;
                }
            }
        });

        // The bridge runs on its own task, the way a forward's loop does, and the test holds the
        // client half. The bridge can only finish once the client closes — a copy across two open
        // ends does not end by itself — so awaiting it before the traffic would be a deadlock.
        let client = tokio::net::TcpStream::connect(incoming_address).await.expect("a connect");
        let (arrived, _) = incoming_listener.accept().await.expect("an accept");

        let connections = Arc::new(AtomicU64::new(0));
        let failures = Arc::new(AtomicU64::new(0));
        let bridging = tokio::spawn({
            let connections = Arc::clone(&connections);
            let failures = Arc::clone(&failures);
            async move {
                bridge_one(
                    Box::new(arrived),
                    Arc::new(DialTo(target_address)),
                    ("127.0.0.1".to_owned(), 0),
                    &connections,
                    &failures,
                )
                .await;
            }
        });

        let mut arrived = client;
        arrived.write_all(b"ping").await.expect("the write");
        let mut buffer = [0u8; 4];
        arrived.read_exact(&mut buffer).await.expect("the echo");
        assert_eq!(&buffer, b"ping", "what went in came back out");
        drop(arrived);

        // The close is what lets the copy end; the timeout only bounds the wait, so a bridge that
        // never finishes fails the test instead of hanging it.
        tokio::time::timeout(std::time::Duration::from_secs(5), bridging)
            .await
            .expect("the bridge finishes once the connection closes")
            .expect("the bridge task joins");

        assert_eq!(connections.load(Ordering::Relaxed), 1);
        assert_eq!(failures.load(Ordering::Relaxed), 0);
    }

    #[tokio::test]
    async fn a_target_the_dialer_cannot_reach_is_a_counted_failure() {
        // Bind a port and let it go, the way the connection tests do: nothing is listening by the
        // time the dial is made.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a listener");
        let port = listener.local_addr().expect("the address").port();
        drop(listener);

        let incoming_listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("a listener");
        let incoming_address = incoming_listener.local_addr().expect("the incoming address");
        let client = tokio::net::TcpStream::connect(incoming_address).await.expect("a connect");
        let (_held, _) = incoming_listener.accept().await.expect("an accept");

        let connections = AtomicU64::new(0);
        let failures = AtomicU64::new(0);
        bridge_one(
            Box::new(client),
            Arc::new(DialTo(SocketAddr::from(([127, 0, 0, 1], port)))),
            ("127.0.0.1".to_owned(), 0),
            &connections,
            &failures,
        )
        .await;

        assert_eq!(connections.load(Ordering::Relaxed), 0);
        assert_eq!(failures.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn the_far_listener_is_reported_at_the_address_the_far_side_bound() {
        assert_eq!(far_listener("0.0.0.0", 40225).ip().to_string(), "0.0.0.0");
        assert_eq!(far_listener("127.0.0.1", 40225).port(), 40225);
        assert_eq!(
            far_listener("localhost", 40225).ip().to_string(),
            "127.0.0.1",
            "a name means the loopback it means"
        );
        assert_eq!(
            far_listener("not-an-address", 40225).ip().to_string(),
            "127.0.0.1",
            "and one that names no address is not read as a wider one"
        );
    }
}
