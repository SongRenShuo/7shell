//! The carrier pool: one server, several connections, the channels spread across them.
//!
//! `MaxSessions` is an arithmetic each *connection* runs under, not one the server runs for
//! everybody: a second SSH connection to the same host arrives with a full channel budget of its
//! own. So the ceiling a carrier's ledger enforces is not the ceiling of the features behind it —
//! an events stream, six log follows and a file browser will fill eight slots and then refuse
//! things a person is actively waiting for, when a second connection would have carried them
//! without a second thought from anybody. The pool is the answer this build makes to that: a
//! group of connections to one `host:port:auth`, grown on demand, with every new channel placed
//! on the carrier that has the most room.
//!
//! Three rules hold the design together:
//!
//! **Growth is on demand and bounded.** A channel that arrives when the freest carrier's count
//! shows `limit - 1` — one slot from full — opens another connection instead of taking the last
//! slot, and so does a channel every carrier has refused. The group stops at
//! [`DEFAULT_POOL_SIZE`] carriers unless the caller chose another bound, and a connect that
//! failed earns a pause, doubled per failure and capped, so a host that is down is not knocked
//! on by every ask. The ledger of each carrier is untouched by any of this: a refusal this side
//! makes still never reaches the server, and a pool that is at its bound refuses the way one
//! connection always did, with the whole group's arithmetic named beside the carrier's.
//!
//! **The events stream never crosses carriers.** Each carrier keeps its own ledger and its own
//! events-yield hook, and an events channel is placed on the carrier it was asked on: the pool
//! neither routes it nor grows for it. At most one events stream rides each carrier, and a pool
//! does not multiply them — the stream and its hook live and die on the same ledger, and the
//! yield still frees exactly the slot the stream held. What the pool does change is the order of
//! room-makers: on a single connection the events stream was the first thing spent when the
//! budget filled; behind a pool, another connection comes first, and the yield is what happens
//! when the pool is at its bound and cannot grow.
//!
//! **A carrier that dies is replaced, not mourned.** A channel open that fails on a carrier for
//! any reason other than the server's own refusal marks that carrier down; the next ask refills
//! the slot through the connect factory — the same route, the same pinned key, the same
//! credential, none of it collected again — with the slot's own backoff pacing the retries.
//! Carriers nobody holds a channel on are closed when the pool next hands one out, so the extra
//! connections a burst grew do not outlive the burst.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sevenshell_error::ShellError;

use crate::budget::{ChannelHolder, HeldChannel};
use crate::session::SshSession;

/// How many connections one pool grows to when nobody chose another.
///
/// Three is enough to carry the bursts a busy host produces — a merged log view, a file browser
/// and a container panel together — without letting a runaway follower multiply connections.
pub const DEFAULT_POOL_SIZE: usize = 3;

/// The way a pool opens one more connection.
///
/// The factory owns whatever the connection needs — the route, the pinned host key, the
/// credential — and is called again for every reconnect. The pool itself keeps no copy of any of
/// it, which is why a reconnect neither asks a person again nor leaves the pool holding a secret
/// the connection it serves was done with.
pub type ConnectFactory =
    Arc<dyn Fn() -> Pin<Box<dyn Future<Output = Result<Arc<SshSession>, ShellError>> + Send>> + Send + Sync>;

/// The connect backoff's base delay: the first failure earns a pause just above the rate the
/// callers actually poll at, the same schedule the fresh-carrier gate in the core runs.
const CONNECT_BASE: Duration = Duration::from_secs(2);

/// The connect backoff's cap. A host that has refused several handshakes in a row is half a
/// minute from the next knock, not next poll.
const CONNECT_CAP: Duration = Duration::from_secs(30);

/// One carrier's place in the group.
///
/// A slot is a position, not a connection: the pool refills a dead slot rather than growing
/// around it, so the primary stays the primary and a flapping host cannot make the group drift.
/// When a connect fails, the failure is remembered *here* — the count, the pause, the reason —
/// because the slot it was meant to fill is exactly the thing waiting to be tried again.
struct CarrierSlot {
    /// The connection, when there is one. `None` is a slot waiting to be refilled.
    session: Option<Arc<SshSession>>,
    /// Connects that failed for this slot, whether the slot was being filled or born.
    failures: u32,
    /// When the next connect for this slot is allowed. A carrier that died is refillable at
    /// once — a pause is what a failed connect earns, not what a connection that went away does.
    next_attempt: Option<Instant>,
    /// What the last connect said, for the error that answers an ask during the pause.
    last_error: Option<String>,
}

/// One carrier's arithmetic, as a caller or a refusal reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CarrierSnapshot {
    /// Whether the connection is there. A down slot is carried in the list so a refill takes
    /// its place rather than a new one.
    pub up: bool,
    /// The channels currently held on this carrier.
    pub held: usize,
    /// The opens this carrier would still accept.
    pub free: usize,
    /// The ceiling this carrier's ledger runs under.
    pub limit: usize,
    /// Per-holder counts, in the holder's own order.
    pub holders: BTreeMap<ChannelHolder, usize>,
}

/// The pool's arithmetic, as a caller or a refusal reads it.
///
/// The totals across carriers are diagnostics only — a fact to read, not a limit that refuses.
/// `MaxSessions` is itself the allocator: each connection's budget is the real arithmetic, and
/// the pool's only hard bound is how many connections it may grow to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PoolSnapshot {
    /// The bound the group grows to.
    pub max: usize,
    /// One snapshot per slot, in the order the slots joined.
    pub carriers: Vec<CarrierSnapshot>,
}

impl PoolSnapshot {
    /// The channels held across every carrier, right now.
    pub fn held(&self) -> usize {
        self.carriers.iter().map(|carrier| carrier.held).sum()
    }

    /// The group's arithmetic as one string, in the shape the budget's own `holders` diagnostic
    /// speaks: one carrier per segment, `index:holder:count,…`, a down carrier marked `down`.
    pub fn diagnostic(&self) -> String {
        self.carriers
            .iter()
            .enumerate()
            .map(|(index, carrier)| {
                if !carrier.up {
                    return format!("{index}:down");
                }
                let holdings = carrier
                    .holders
                    .iter()
                    .map(|(holder, held)| format!("{}:{}", holder.as_str(), held))
                    .collect::<Vec<_>>()
                    .join(",");
                if holdings.is_empty() {
                    format!("{index}:-")
                } else {
                    format!("{index}:{holdings}")
                }
            })
            .collect::<Vec<_>>()
            .join("|")
    }
}

/// A group of connections to one server, so one connection's channel ceiling is not the ceiling
/// of the features behind it.
///
/// A pool holds its carriers; the carriers join it (see [`SshSession::join_pool`]) and place
/// every channel they are asked for on the member with the most room. Cloning shares the group.
pub struct CarrierPool {
    inner: Arc<PoolInner>,
}

/// The parts the guards and the carriers reach. One per connection group.
pub(crate) struct PoolInner {
    /// The bound the group grows to.
    max: usize,
    /// How one more connection comes to be, wherever the pool needs it.
    connect: ConnectFactory,
    /// One handshake at a time, whatever brought it on: growth and pruning both reshape the
    /// slot list, and a refill of a dead carrier is the same socket to the same server as an
    /// expansion is. Serializing them keeps the slot list's order honest under concurrency.
    connecting: tokio::sync::Mutex<()>,
    /// The slots, in the order they joined. The first up slot is the primary.
    carriers: Mutex<Vec<CarrierSlot>>,
    /// The peer the carriers serve, learned from the first connection that joined. What the
    /// backoff error names when every carrier is down.
    peer: Mutex<Option<(String, u16)>>,
}

impl CarrierPool {
    /// A pool of the default size, grown by `connect`.
    pub fn new(connect: ConnectFactory) -> Self {
        Self::with_limit(connect, DEFAULT_POOL_SIZE)
    }

    /// A pool of at most `max` connections. A bound under one is taken as one: a pool that may
    /// not hold a connection holds none.
    pub fn with_limit(connect: ConnectFactory, max: usize) -> Self {
        Self {
            inner: Arc::new(PoolInner {
                max: max.max(1),
                connect,
                connecting: tokio::sync::Mutex::new(()),
                carriers: Mutex::new(Vec::new()),
                peer: Mutex::new(None),
            }),
        }
    }

    /// Names the peer the pool serves, for the errors a paused pool answers with.
    ///
    /// A pool learns its peer from the first connection that joins; this is for the ask that
    /// arrives while every connect so far has failed, where there is no connection to have
    /// learned from and the pause should still name the host it is about.
    pub fn with_peer(self, host: impl Into<String>, port: u16) -> Self {
        *self.inner.peer.lock().expect("the pool's peer lock") = Some((host.into(), port));
        self
    }

    /// Hands out the carrier a new consumer should ride: the one with the most room, or a fresh
    /// connection when every carrier is one slot from full. What the consumer then opens is its
    /// own business — its channels are placed by the pool like every other carrier's.
    pub async fn carrier(&self) -> Result<Arc<SshSession>, ShellError> {
        PoolInner::carrier(&self.inner).await
    }

    /// The pool's arithmetic, for a caller that reads before it asks and for the diagnostics a
    /// refusal carries.
    pub fn snapshot(&self) -> PoolSnapshot {
        self.inner.snapshot()
    }

    /// Closes every carrier the pool is holding, and forgets them. The pool stays usable: the
    /// next ask opens a connection the ordinary way.
    pub async fn close(&self) {
        self.inner.close().await
    }
}

impl PoolInner {
    /// The carrier with the most room, and how much room it has.
    ///
    /// Ties go to the oldest carrier, so an ask that could go anywhere lands somewhere
    /// predictable and a consumer that asks twice in a row is not shuffled between connections
    /// for nothing.
    fn freest(&self) -> Option<(Arc<SshSession>, usize)> {
        let carriers = self.carriers.lock().expect("the pool's carriers lock");
        let mut best: Option<(Arc<SshSession>, usize)> = None;
        for slot in carriers.iter() {
            let Some(session) = &slot.session else { continue };
            let free = session.channel_budget().free;
            let better = match &best {
                // Strictly better, so a tie keeps the carrier that joined first.
                Some((_, best_free)) => free > *best_free,
                None => true,
            };
            if better {
                best = Some((Arc::clone(session), free));
            }
        }
        best
    }

    /// The snapshot a caller or a refusal reads from.
    fn snapshot(&self) -> PoolSnapshot {
        let carriers = self.carriers.lock().expect("the pool's carriers lock");
        PoolSnapshot {
            max: self.max,
            carriers: carriers
                .iter()
                .map(|slot| match &slot.session {
                    Some(session) => {
                        let budget = session.channel_budget();
                        CarrierSnapshot {
                            up: true,
                            held: budget.held,
                            free: budget.free,
                            limit: budget.limit,
                            holders: budget.holders,
                        }
                    }
                    None => CarrierSnapshot {
                        up: false,
                        held: 0,
                        free: 0,
                        limit: 0,
                        holders: BTreeMap::new(),
                    },
                })
                .collect(),
        }
    }

    /// Places a channel on the carrier with the most room, growing the group when none of them
    /// has room to spare.
    ///
    /// The order of the attempts is the order of their cost: a carrier with room takes the
    /// channel at once; a group one slot from full grows before the channel is placed, so the
    /// ask never waits on a handshake that another connection makes unnecessary; and the freest
    /// carrier's own ledger — whose yield path is the last room-maker a single connection had —
    /// answers only when growth was not due or did not come off.
    pub(crate) async fn acquire(
        inner: &Arc<Self>,
        holder: ChannelHolder,
        what: &str,
    ) -> Result<(Arc<SshSession>, HeldChannel), ShellError> {
        if let Some((session, free)) = inner.freest()
            && free >= 2
            && let Ok(held) = session.acquire_channel(holder, what).await
        {
            return Ok((session, held));
        }

        let mut connect_failure = None;
        if holder != ChannelHolder::Events {
            match PoolInner::grow(inner).await {
                Ok(Some(fresh)) => {
                    let held = fresh.acquire_channel(holder, what).await?;
                    return Ok((fresh, held));
                }
                // Growth was not due; the answer continues below.
                Ok(None) => {}
                // The connect failed. If a carrier is still up, the answer continues below —
                // its ledger, and the yield it can run, are worth more than the failure. If
                // not, the failure is the answer: a pause error would hide what happened.
                Err(error) => connect_failure = Some(error),
            }
        }

        let Some((session, _)) = inner.freest() else {
            return Err(connect_failure.unwrap_or_else(|| inner.paused_error()));
        };
        match session.acquire_channel(holder, what).await {
            Ok(held) => Ok((session, held)),
            Err(error) => Err(inner.refusal(&session, what, &error)),
        }
    }

    /// Hands a carrier out, growing the group when every member is one slot from full, and
    /// closing the carriers nobody holds a channel on.
    pub(crate) async fn carrier(inner: &Arc<Self>) -> Result<Arc<SshSession>, ShellError> {
        let chosen = match inner.freest() {
            Some((session, free)) if free >= 2 => session,
            _ => match PoolInner::grow(inner).await {
                Ok(Some(fresh)) => fresh,
                Ok(None) => {
                    let Some((session, _)) = inner.freest() else {
                        return Err(inner.paused_error());
                    };
                    session
                }
                Err(error) => {
                    // The connect failed. A carrier still up is the answer; without one, the
                    // failure is — a pause error would hide what actually happened.
                    let Some((session, _)) = inner.freest() else {
                        return Err(error);
                    };
                    session
                }
            },
        };
        inner.prune(&chosen).await;
        Ok(chosen)
    }

    /// Opens one more connection — a refill of the first dead slot when there is one, a new
    /// slot when there is not — and answers it.
    ///
    /// `Ok(None)` says growth was not due: the group is at its bound, or the slot's pause has
    /// not run out. The factory's error is the caller's answer when the connect itself failed,
    /// and it earns the slot its pause — doubled per failure, capped, the same schedule the
    /// fresh-carrier gate in the core runs, so a host that is down is paced the same whichever
    /// throttle speaks.
    ///
    /// The owning `Arc` travels with the call because the connection it opens has to join the
    /// pool it was born into, and the link a carrier keeps back at the pool is weak.
    async fn grow(inner: &Arc<Self>) -> Result<Option<Arc<SshSession>>, ShellError> {
        let _serial = inner.connecting.lock().await;
        let fill = {
            let carriers = inner.carriers.lock().expect("the pool's carriers lock");
            let up = carriers.iter().filter(|slot| slot.session.is_some()).count();
            if up >= inner.max {
                return Ok(None);
            }
            match carriers.iter().position(|slot| slot.session.is_none()) {
                Some(index) => {
                    let slot = &carriers[index];
                    if slot.next_attempt.is_some_and(|until| Instant::now() < until) {
                        return Ok(None);
                    }
                    Fill::Refill(index)
                }
                None => Fill::Append,
            }
        };

        let opened = (inner.connect)().await;
        let session = match opened {
            Ok(session) => session,
            Err(error) => {
                let mut carriers = inner.carriers.lock().expect("the pool's carriers lock");
                let slot = match fill {
                    Fill::Refill(index) => carriers.get_mut(index),
                    // A failed append is remembered as a slot waiting to be filled, so the
                    // bound holds and the pause is kept where the retry will look.
                    Fill::Append => {
                        carriers.push(CarrierSlot {
                            session: None,
                            failures: 0,
                            next_attempt: None,
                            last_error: None,
                        });
                        carriers.last_mut()
                    }
                };
                if let Some(slot) = slot {
                    slot.failures = slot.failures.saturating_add(1);
                    slot.next_attempt = Some(Instant::now() + connect_delay(slot.failures));
                    slot.last_error = Some(error.detail().map(str::to_owned).unwrap_or_else(|| error.to_string()));
                }
                return Err(error);
            }
        };

        session.join_pool(inner);
        if inner.peer.lock().expect("the pool's peer lock").is_none() {
            *inner.peer.lock().expect("the pool's peer lock") = Some((session.host.clone(), session.port));
        }

        let mut carriers = inner.carriers.lock().expect("the pool's carriers lock");
        match fill {
            Fill::Refill(index) => {
                if let Some(slot) = carriers.get_mut(index) {
                    slot.session = Some(Arc::clone(&session));
                    slot.failures = 0;
                    slot.next_attempt = None;
                    slot.last_error = None;
                }
            }
            Fill::Append => carriers.push(CarrierSlot {
                session: Some(Arc::clone(&session)),
                failures: 0,
                next_attempt: None,
                last_error: None,
            }),
        }
        Ok(Some(session))
    }

    /// Takes a carrier down, by the connection itself.
    ///
    /// The slot keeps its place and is refillable at once: a connection that went away is a fact
    /// about the past, and the pause a connect failure earns is the only thing that holds a
    /// refill back.
    pub(crate) fn mark_down(&self, carrier: &SshSession) {
        let mut carriers = self.carriers.lock().expect("the pool's carriers lock");
        for slot in carriers.iter_mut() {
            let Some(session) = &slot.session else { continue };
            if std::ptr::eq(&**session, carrier) {
                slot.session = None;
                slot.next_attempt = None;
                break;
            }
        }
    }

    /// Closes the carriers nobody holds a channel on, keeping `keep` and at least one carrier
    /// besides.
    ///
    /// Only idle carriers go — a carrier with a held channel is carrying something — and the
    /// list shrinks rather than the slots: the group remembers how many connections it grew to
    /// so a refill takes a place that already existed. A consumer whose carrier is closed here
    /// had opened nothing on it; its next open is placed like any other.
    async fn prune(&self, keep: &SshSession) {
        let _serial = self.connecting.lock().await;
        loop {
            let victim = {
                let mut carriers = self.carriers.lock().expect("the pool's carriers lock");
                let up = carriers.iter().filter(|slot| slot.session.is_some()).count();
                if up <= 1 {
                    break;
                }
                let index = carriers.iter().position(|slot| {
                    slot.session
                        .as_ref()
                        .is_some_and(|session| !std::ptr::eq(&**session, keep) && session.channel_budget().held == 0)
                });
                match index {
                    Some(index) => carriers[index].session.take().map(|session| (index, session)),
                    None => break,
                }
            };
            let Some((index, session)) = victim else { break };
            let _ = session.close().await;
            self.carriers.lock().expect("the pool's carriers lock").remove(index);
        }
    }

    /// Closes every carrier and forgets the slots. The pool answers the next ask with a fresh
    /// group.
    pub(crate) async fn close(&self) {
        let _serial = self.connecting.lock().await;
        let carriers = {
            let mut guards = self.carriers.lock().expect("the pool's carriers lock");
            std::mem::take(&mut *guards)
        };
        for slot in carriers {
            if let Some(session) = slot.session {
                let _ = session.close().await;
            }
        }
    }

    /// The envelope an ask carries when the pool is at its bound and every carrier's ledger has
    /// refused — including after the yield ran on the freest carrier.
    ///
    /// The message names the whole group's arithmetic, because "close some log streams" is
    /// advice that has to survive being spread over several connections: the pools diagnostic
    /// says who holds what on which carrier, and `pool_held` says what the group carries in
    /// total — a fact to read, deliberately not a limit that refused anything.
    fn refusal(&self, carrier: &SshSession, what: &str, ledger_error: &ShellError) -> ShellError {
        let snapshot = self.snapshot();
        let (host, port) = carrier.peer();
        let budget = carrier.channel_budget();
        let up = snapshot.carriers.iter().filter(|carrier| carrier.up).count();
        let pool_held = snapshot.held();
        let error = ShellError::ssh_channel_refused(
            host,
            port,
            format!(
                "{what} was refused: every connection this host's pool keeps is full — the freest \
                 carries {}/{} and the pool holds {pool_held} across {up} connections, its bound \
                 of {} reached — close some log streams or terminals and try again",
                budget.held, budget.limit, snapshot.max
            ),
        )
        .with_param("held", budget.held.to_string())
        .with_param("limit", budget.limit.to_string())
        .with_param("pool_held", pool_held.to_string())
        .with_diagnostic("held", budget.held.to_string())
        .with_diagnostic("limit", budget.limit.to_string())
        .with_diagnostic("carriers", format!("{up}/{}", snapshot.max))
        .with_diagnostic("pool_held", pool_held.to_string())
        .with_diagnostic("pools", snapshot.diagnostic());
        // The yield was spent before the pool refused — the freest carrier's events stream was
        // stopped for nothing, and the answer has to say so, the way a single connection's
        // refusal always has.
        if ledger_error.diagnostics().get("yielded").map(String::as_str) == Some("events") {
            error.with_diagnostic("yielded", "events")
        } else {
            error
        }
    }

    /// The error that answers an ask when every carrier is down and the next connect is still
    /// under its pause. The reason is the connect's own; the shape is the one the fresh-carrier
    /// gate answers with.
    fn paused_error(&self) -> ShellError {
        let carriers = self.carriers.lock().expect("the pool's carriers lock");
        let waiting = carriers
            .iter()
            .filter_map(|slot| {
                slot.next_attempt
                    .map(|until| (slot.failures, until, slot.last_error.clone().unwrap_or_default()))
            })
            .max_by_key(|(_, until, _)| *until);
        let Some((failures, until, reason)) = waiting else {
            return ShellError::app_internal("the pool has no carrier and no connect was due");
        };
        let seconds = until.saturating_duration_since(Instant::now()).as_secs().max(1);
        match &*self.peer.lock().expect("the pool's peer lock") {
            Some((host, port)) => ShellError::ssh_backoff(
                host,
                *port,
                seconds,
                failures,
                format!(
                    "the pool's last connection attempt to {host}:{port} failed ({reason}); the \
                     next attempt is allowed in {seconds} seconds"
                ),
            ),
            None => ShellError::app_busy(format!(
                "the pool's last connection attempt failed ({reason}); the next attempt is \
                 allowed in {seconds} seconds"
            )),
        }
    }
}

/// What a connect is for: filling a place the group already remembers, or adding one.
enum Fill {
    Refill(usize),
    Append,
}

/// The pause a connect failure earns: the base doubled each failure, capped, the schedule the
/// fresh-carrier gate runs. There is no jitter here because a pool's connects are serialized —
/// the thing jitter protects against, several callers knocking together, cannot happen.
fn connect_delay(failures: u32) -> Duration {
    let doublings = failures.saturating_sub(1).min(20);
    let grown = Duration::from_secs(CONNECT_BASE.as_secs() << doublings);
    grown.min(CONNECT_CAP)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_pools_arithmetic_reads_as_one_segment_per_carrier() {
        let mut holders = BTreeMap::new();
        holders.insert(ChannelHolder::Exec, 3usize);
        holders.insert(ChannelHolder::Logs, 4usize);
        let snapshot = PoolSnapshot {
            max: 3,
            carriers: vec![
                CarrierSnapshot {
                    up: true,
                    held: 7,
                    free: 1,
                    limit: 8,
                    holders: holders.clone(),
                },
                CarrierSnapshot {
                    up: true,
                    held: 0,
                    free: 8,
                    limit: 8,
                    holders: BTreeMap::new(),
                },
                CarrierSnapshot {
                    up: false,
                    held: 0,
                    free: 0,
                    limit: 0,
                    holders: BTreeMap::new(),
                },
            ],
        };
        assert_eq!(snapshot.diagnostic(), "0:logs:4,exec:3|1:-|2:down");
        assert_eq!(snapshot.held(), 7);
    }

    #[test]
    fn a_connect_failure_doubles_its_pause_and_stops_at_the_cap() {
        assert_eq!(connect_delay(1), Duration::from_secs(2));
        assert_eq!(connect_delay(2), Duration::from_secs(4));
        assert_eq!(connect_delay(3), Duration::from_secs(8));
        assert_eq!(connect_delay(4), Duration::from_secs(16));
        assert_eq!(connect_delay(5), CONNECT_CAP);
        assert_eq!(connect_delay(50), CONNECT_CAP);
    }
}
