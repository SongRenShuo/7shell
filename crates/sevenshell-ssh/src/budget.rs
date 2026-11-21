//! The channel budget: how many channels one connection may hold, and who holds them.
//!
//! A server answers every channel open with its own `MaxSessions` arithmetic, and an exhausted
//! budget there refuses everything else on the connection. The refusal is honest but useless after
//! the fact — the holder of the ninth channel was the events stream opened hours ago, and nothing
//! told anyone. So the connection keeps its own ledger: every channel this side opens is counted
//! under the feature that opened it, every deterministic close releases its slot, and an open that
//! would cross the ceiling is refused *here*, before the server sees it, with a diagnostic that
//! names the holders.
//!
//! The ceiling deliberately sits under a server's `MaxSessions`: eight, against OpenSSH's default
//! ten, so two slots stay free for the asks nobody scheduled — a sudden read, a file listing, a
//! person opening a terminal in an emergency. Only *session* channels are counted, because that is
//! what `MaxSessions` governs; a `direct-tcpip` hop rides a different arithmetic and is not
//! charged here.
//!
//! The events stream is the designated yielder. It is the cheapest thing to lose — the list falls
//! back to a manual refresh — and the most likely thing to be old. When an open would cross the
//! ceiling and the ledger holds events channels, the registered yield hook (the stream's owner
//! registers it when the stream starts) closes the events stream first, the slot comes back, and
//! the new open proceeds. A refusal that survives that says so in its diagnostics.

use std::collections::BTreeMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use sevenshell_error::ShellError;

/// The ceiling one connection's ledger uses when nobody chose another.
///
/// A server's `MaxSessions` defaults to ten; two slots are kept free for the unscheduled asks a
/// person or a page can make while every long-lived stream is out.
pub const DEFAULT_CHANNEL_LIMIT: usize = 8;

/// How long the yield path waits for a released slot before it gives up and refuses.
///
/// The hook stops a stream; the release lands when the task holding the channel notices and
/// drops it. That is quick on a live connection, and bounded here so a stalled task turns into
/// a refusal rather than a hang.
const YIELD_RELEASE_CEILING: Duration = Duration::from_secs(1);

/// How long one poll of the release wait sleeps before it re-checks the count.
const YIELD_RELEASE_POLL: Duration = Duration::from_millis(25);

/// The feature a held channel belongs to — the vocabulary the refusal's diagnostics speak.
///
/// These are names a person can act on: "close some log streams" only helps if the refusal can
/// say that log streams are what is holding the slots.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum ChannelHolder {
    /// The engine's event stream a container list follows.
    Events,
    /// A log follow — one container, or one of a merged view's streams.
    Logs,
    /// A pseudo terminal: a terminal tab, a container exec.
    Pty,
    /// One command: a capture, a transfer, a subsystem, a compose watch.
    Exec,
}

impl ChannelHolder {
    /// The diagnostic's spelling, which is also the wire's.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Events => "events",
            Self::Logs => "logs",
            Self::Pty => "pty",
            Self::Exec => "exec",
        }
    }
}

/// One held slot. Released once — by the explicit release or by the drop, whichever comes first.
///
/// Cloning shares the slot: a channel whose halves live in two tasks (a command's input and its
/// reader) holds one slot, not two, and the slot frees when the last half's task ends.
#[derive(Clone)]
pub struct HeldChannel {
    slot: Arc<Slot>,
}

impl std::fmt::Debug for HeldChannel {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HeldChannel")
            .field("holder", &self.slot.holder)
            .finish()
    }
}

struct Slot {
    holder: ChannelHolder,
    released: AtomicBool,
    /// Shared with the ledger, so a release of any slot can mark it.
    ledger: Arc<ChannelLedgerInner>,
}

impl HeldChannel {
    /// Gives the slot back at once. A later drop finds it already given and does nothing.
    pub fn release(&self) {
        if self.slot.released.swap(true, Ordering::SeqCst) {
            return;
        }
        self.slot.ledger.release_slot(self.slot.holder);
    }
}

impl Drop for HeldChannel {
    fn drop(&mut self) {
        if self.slot.released.swap(true, Ordering::SeqCst) {
            return;
        }
        self.slot.ledger.release_slot(self.slot.holder);
    }
}

/// The snapshot a caller reads to answer "is there room": the ceiling, the count, and who holds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeldChannels {
    /// The ceiling this connection runs under.
    pub limit: usize,
    /// The channels currently held, across every holder.
    pub held: usize,
    /// The opens that would still be accepted.
    pub free: usize,
    /// Per-holder counts, in the holder's own order.
    pub holders: BTreeMap<ChannelHolder, usize>,
}

/// The yield hook a stream's owner registers: stop the events stream, so a budget refusal can
/// become an open instead.
///
/// The hook is async because stopping a stream is sending on queues and dropping tasks; it is
/// infallible because a stop that fails means the stream was already gone, which is the state the
/// yield wanted.
pub type YieldHook = Arc<dyn Fn() -> Pin<Box<dyn Future<Output = ()> + Send>> + Send + Sync>;

/// The parts of the ledger the guards and the slots reach. One per connection.
struct ChannelLedgerInner {
    limit: usize,
    held: Mutex<BTreeMap<ChannelHolder, usize>>,
    /// The events stream's yield hook, when its owner registered one.
    yield_hook: Mutex<Option<YieldHook>>,
}

impl ChannelLedgerInner {
    fn count(&self, holder: ChannelHolder) -> usize {
        self.held
            .lock()
            .expect("the ledger is never poisoned")
            .get(&holder)
            .copied()
            .unwrap_or(0)
    }

    fn total(&self) -> usize {
        self.held.lock().expect("the ledger is never poisoned").values().sum()
    }

    fn release_slot(&self, holder: ChannelHolder) {
        let mut held = self.held.lock().expect("the ledger is never poisoned");
        let entry = held.entry(holder).or_insert(0);
        // A release past zero would mean an accounting bug upstream; the floor keeps the count
        // honest enough to read even then, and the symptom stays visible in the numbers.
        *entry = entry.saturating_sub(1);
        if *entry == 0 {
            held.remove(&holder);
        }
    }
}

/// The budget one connection keeps: who holds how many, and whether one more may open.
#[derive(Clone)]
pub struct ChannelLedger {
    inner: Arc<ChannelLedgerInner>,
}

impl Default for ChannelLedger {
    fn default() -> Self {
        Self::new(DEFAULT_CHANNEL_LIMIT)
    }
}

impl ChannelLedger {
    /// A ledger with the ceiling `limit` chosen for it.
    pub fn new(limit: usize) -> Self {
        Self {
            inner: Arc::new(ChannelLedgerInner {
                limit,
                held: Mutex::new(BTreeMap::new()),
                yield_hook: Mutex::new(None),
            }),
        }
    }

    /// The ceiling this connection runs under.
    pub fn limit(&self) -> usize {
        self.inner.limit
    }

    /// The channels currently held, across every holder.
    pub fn held(&self) -> usize {
        self.inner.total()
    }

    /// The opens that would still be accepted.
    pub fn free(&self) -> usize {
        self.inner.limit.saturating_sub(self.inner.total())
    }

    /// The per-holder counts, in the holder's own order.
    pub fn holdings(&self) -> BTreeMap<ChannelHolder, usize> {
        self.inner.held.lock().expect("the ledger is never poisoned").clone()
    }

    /// The snapshot a caller answers "is there room" from.
    pub fn snapshot(&self) -> HeldChannels {
        let holders = self.holdings();
        let held = holders.values().sum();
        HeldChannels {
            limit: self.inner.limit,
            held,
            free: self.inner.limit.saturating_sub(held),
            holders,
        }
    }

    /// Registers the yield hook for the events stream this connection follows.
    ///
    /// One connection follows at most one events stream, so one slot holds the hook; a stream
    /// that replaces an old one replaces the hook with it, and a `None` clears it.
    pub fn set_yield_hook(&self, hook: Option<YieldHook>) {
        *self.inner.yield_hook.lock().expect("the ledger is never poisoned") = hook;
    }

    /// Takes one slot for `holder`, refusing with the budget envelope when none is left.
    ///
    /// The refusal is built here rather than mapped from a server answer, because it never
    /// reaches the server: the count crossed the ceiling before the open was sent. The yield
    /// path runs first when it can — see [`Self::acquire_with_yield`].
    pub fn try_acquire(&self, holder: ChannelHolder) -> Option<HeldChannel> {
        let mut held = self.inner.held.lock().expect("the ledger is never poisoned");
        let total: usize = held.values().sum();
        if total >= self.inner.limit {
            return None;
        }
        *held.entry(holder).or_insert(0) += 1;
        Some(HeldChannel {
            slot: Arc::new(Slot {
                holder,
                released: AtomicBool::new(false),
                ledger: Arc::clone(&self.inner),
            }),
        })
    }

    /// Takes one slot for `holder`, yielding the events stream first when the ceiling is reached.
    ///
    /// The order of an exhausted budget matters: the events stream is a convenience a person
    /// notices less than a refused log or terminal, and it is the holder most likely to have been
    /// open for hours. When the ledger holds events channels and a hook is registered, the hook
    /// runs, the slot comes back, and the open proceeds — the caller never learns there was a
    /// refusal to recover from. A refusal that survives the yield carries `yielded: events` so
    /// the answer can say the events stream was spent on the attempt.
    pub async fn acquire(
        &self,
        holder: ChannelHolder,
        host: &str,
        port: u16,
        what: &str,
    ) -> Result<HeldChannel, ShellError> {
        if let Some(held) = self.try_acquire(holder) {
            return Ok(held);
        }

        let hook = self
            .inner
            .yield_hook
            .lock()
            .expect("the ledger is never poisoned")
            .clone();
        if holder != ChannelHolder::Events
            && self.inner.count(ChannelHolder::Events) > 0
            && let Some(hook) = hook
        {
            hook().await;
            // The stop travels; the slot comes back when the task holding the channel drops it.
            // Bounded here so a stalled task becomes a refusal, not a hang.
            let _released = tokio::time::timeout(YIELD_RELEASE_CEILING, async {
                while self.inner.count(ChannelHolder::Events) > 0 {
                    tokio::time::sleep(YIELD_RELEASE_POLL).await;
                }
            })
            .await;

            if let Some(held) = self.try_acquire(holder) {
                return Ok(held);
            }

            // The yield was spent — the events stream was stopped, whatever the count now says —
            // but the slot did not come back (or another ask took it). The refusal has to say so:
            // the person reading it should know the events stream is gone even though the ask
            // still failed.
            return Err(self.refusal(host, port, what, Some(ChannelHolder::Events)));
        }

        Err(self.refusal(host, port, what, None))
    }

    /// The envelope an open refused by this build's own budget carries.
    ///
    /// The message names the arithmetic (n over the ceiling) and the way out, because a person
    /// with four log streams and two terminals open is the one who has to close something. The
    /// diagnostics keep the machine-readable half: the counts per holder, and the yield marker
    /// when the events stream was spent on the attempt.
    pub fn refusal(&self, host: &str, port: u16, what: &str, yielded: Option<ChannelHolder>) -> ShellError {
        let snapshot = self.snapshot();
        let holders = snapshot
            .holders
            .iter()
            .map(|(holder, count)| format!("{}:{}", holder.as_str(), count))
            .collect::<Vec<_>>()
            .join(",");
        let error = ShellError::ssh_channel_refused(
            host,
            port,
            format!(
                "{what} was refused by this build's own channel budget: the connection's channels \
                 are full ({}/{}) — close some log streams or terminals and try again",
                snapshot.held, snapshot.limit
            ),
        )
        .with_param("held", snapshot.held.to_string())
        .with_param("limit", snapshot.limit.to_string())
        .with_diagnostic("held", snapshot.held.to_string())
        .with_diagnostic("limit", snapshot.limit.to_string());
        let error = if holders.is_empty() {
            error
        } else {
            error.with_diagnostic("holders", holders)
        };
        match yielded {
            Some(holder) => error.with_diagnostic("yielded", holder.as_str()),
            None => error,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_error::ErrorCode;
    use std::sync::atomic::AtomicUsize;

    #[test]
    fn a_holder_names_itself_as_the_diagnostics_do() {
        assert_eq!(ChannelHolder::Events.as_str(), "events");
        assert_eq!(ChannelHolder::Logs.as_str(), "logs");
        assert_eq!(ChannelHolder::Pty.as_str(), "pty");
        assert_eq!(ChannelHolder::Exec.as_str(), "exec");
    }

    #[test]
    fn an_open_under_the_ceiling_is_taken_and_a_release_gives_it_back() {
        let ledger = ChannelLedger::new(2);
        let first = ledger.try_acquire(ChannelHolder::Logs).expect("the first open");
        assert_eq!(ledger.held(), 1);
        assert_eq!(ledger.free(), 1);
        let second = ledger.try_acquire(ChannelHolder::Logs).expect("the second open");
        assert_eq!(ledger.free(), 0);

        drop(first);
        assert_eq!(ledger.held(), 1, "the drop released exactly one slot");
        drop(second);
        assert_eq!(ledger.held(), 0);
        assert_eq!(ledger.holdings().len(), 0, "an empty holder leaves no row behind");
    }

    #[test]
    fn a_release_happens_once_whatever_waits_for_it() {
        // A channel whose halves live in two tasks shares one slot; an explicit release and a
        // drop of a clone must not take the count down twice.
        let ledger = ChannelLedger::new(2);
        let held = ledger.try_acquire(ChannelHolder::Exec).expect("the open");
        let clone = held.clone();
        held.release();
        assert_eq!(ledger.held(), 0);
        drop(clone);
        assert_eq!(ledger.held(), 0, "the clone's drop found the slot already released");
    }

    #[test]
    fn an_open_over_the_ceiling_is_refused_here_with_the_holders_named() {
        let ledger = ChannelLedger::new(2);
        let _first = ledger.try_acquire(ChannelHolder::Events).expect("the events open");
        let _second = ledger.try_acquire(ChannelHolder::Logs).expect("the log open");

        let error = ledger.refusal("host.example", 22, "a channel for a log", None);
        assert_eq!(error.code(), ErrorCode::SshChannelRefused);
        assert_eq!(
            error.message_params().get("held").map(String::as_str),
            Some("2"),
            "the message names how full the connection is"
        );
        assert_eq!(error.message_params().get("limit").map(String::as_str), Some("2"));
        let diagnostics = error.diagnostics();
        assert_eq!(
            diagnostics.get("holders").map(String::as_str),
            Some("events:1,logs:1"),
            "the refusal lists who holds what: {:?}",
            diagnostics
        );
        assert!(diagnostics.get("yielded").is_none(), "no yield was attempted");
        assert!(error.detail().unwrap_or_default().contains("channels are full (2/2)"));
    }

    #[tokio::test]
    async fn an_open_over_the_ceiling_yields_the_events_stream_and_takes_the_freed_slot() {
        let ledger = ChannelLedger::new(2);
        let events = ledger.try_acquire(ChannelHolder::Events).expect("the events open");
        let _log = ledger.try_acquire(ChannelHolder::Logs).expect("the log open");

        // The hook stands in for the events stream's owner: it stops the stream, whose slot
        // comes back. The release here is synchronous, the way a stream that was already ending
        // releases; the wait must not need a single poll to see it. The hook gives the slot back
        // through the ledger directly, because the test has no stream whose drop would do it.
        let counter = Arc::new(AtomicUsize::new(0));
        let hook_counter = Arc::clone(&counter);
        let hook_ledger = ledger.clone();
        ledger.set_yield_hook(Some(Arc::new(move || {
            hook_counter.fetch_add(1, Ordering::SeqCst);
            hook_ledger.inner.release_slot(ChannelHolder::Events);
            Box::pin(async {}) as Pin<Box<dyn Future<Output = ()> + Send>>
        })));

        let opened = ledger
            .acquire(ChannelHolder::Logs, "host.example", 22, "a channel for a second log")
            .await
            .expect("the yield made room");
        assert_eq!(counter.load(Ordering::SeqCst), 1, "the hook ran once");
        assert_eq!(
            ledger.holdings().get(&ChannelHolder::Events),
            None,
            "the events stream yielded"
        );
        drop(opened);
        drop(events);
        ledger.set_yield_hook(None);
    }

    #[tokio::test]
    async fn a_refusal_after_a_spent_yield_says_the_yield_happened() {
        // The ceiling is crossed, the events stream is the only holder, and its hook yields —
        // but nothing actually releases (a stalled stream). The refusal carries the yield marker
        // so the answer can say the events stream was spent on this attempt.
        let ledger = ChannelLedger::new(1);
        let _events = ledger.try_acquire(ChannelHolder::Events).expect("the events open");
        ledger.set_yield_hook(Some(Arc::new(|| {
            // A stop that never lands: the slot stays taken.
            Box::pin(async {}) as Pin<Box<dyn Future<Output = ()> + Send>>
        })));

        let error = ledger
            .acquire(ChannelHolder::Logs, "host.example", 22, "a channel for a log")
            .await
            .expect_err("the slot never came back");
        assert_eq!(error.code(), ErrorCode::SshChannelRefused);
        assert_eq!(
            error.diagnostics().get("yielded").map(String::as_str),
            Some("events"),
            "the refusal says the events stream was yielded: {:?}",
            error.diagnostics()
        );
    }

    #[tokio::test]
    async fn an_events_open_that_crosses_the_ceiling_is_refused_without_a_yield() {
        // The events stream asking for room cannot yield to itself; the refusal is plain.
        let ledger = ChannelLedger::new(1);
        let _log = ledger.try_acquire(ChannelHolder::Logs).expect("the log open");
        ledger.set_yield_hook(Some(Arc::new(|| {
            panic!("an events open must not run the yield hook");
        })));

        let error = ledger
            .acquire(ChannelHolder::Events, "host.example", 22, "a channel for the events")
            .await
            .expect_err("the ceiling is reached");
        assert_eq!(error.diagnostics().get("yielded"), None);
    }

    #[tokio::test]
    async fn a_full_budget_without_events_holders_is_refused_at_once() {
        let ledger = ChannelLedger::new(1);
        let _pty = ledger.try_acquire(ChannelHolder::Pty).expect("the pty open");
        ledger.set_yield_hook(Some(Arc::new(|| {
            panic!("no events holder, so no hook may run");
        })));

        let error = ledger
            .acquire(ChannelHolder::Logs, "host.example", 22, "a channel for a log")
            .await
            .expect_err("the ceiling is reached");
        assert_eq!(error.diagnostics().get("holders").map(String::as_str), Some("pty:1"));
        assert_eq!(error.diagnostics().get("yielded"), None);
    }

    #[test]
    fn the_snapshot_answers_what_a_caller_reads() {
        let ledger = ChannelLedger::default();
        assert_eq!(ledger.limit(), DEFAULT_CHANNEL_LIMIT);
        let _a = ledger.try_acquire(ChannelHolder::Events);
        let _b = ledger.try_acquire(ChannelHolder::Logs);
        let _c = ledger.try_acquire(ChannelHolder::Pty);
        let snapshot = ledger.snapshot();
        assert_eq!(snapshot.held, 3);
        assert_eq!(snapshot.free, DEFAULT_CHANNEL_LIMIT - 3);
        assert_eq!(snapshot.holders.get(&ChannelHolder::Events), Some(&1));
    }

    #[test]
    fn a_zero_ceiling_refuses_everything_and_names_no_holders() {
        let ledger = ChannelLedger::new(0);
        let error = ledger.refusal("host.example", 22, "a channel", None);
        assert_eq!(error.code(), ErrorCode::SshChannelRefused);
        assert_eq!(
            error.diagnostics().get("holders"),
            None,
            "nothing is held, so nobody is named"
        );
        assert_eq!(error.message_params().get("held").map(String::as_str), Some("0"));
    }
}
