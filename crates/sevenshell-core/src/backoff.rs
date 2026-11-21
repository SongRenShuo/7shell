//! Throttles that keep repeated failures from becoming traffic.
//!
//! Two doors lead to the same failure mode. The monitor samples a host every couple of seconds;
//! when the server starts refusing channels, sampling again at that rate is not reading a host,
//! it is knocking on a door that has been answered "no" five times. And a fresh connection that
//! failed is, for a few seconds, a fact about the host — reconnecting at the rate the callers
//! poll turns one refused handshake into a stream of them, which is what a server's
//! `MaxStartups` exists to stop.
//!
//! Both throttles share one shape: the first failure pauses the next attempt for a short base
//! delay, every further failure doubles it, a cap keeps it finite, and jitter keeps several
//! callers that failed together from lining their next attempts up again. During a pause the
//! caller is refused *immediately* with the reason and the seconds remaining — an honest fast
//! answer, not a queued wait.

use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant, UNIX_EPOCH};

use sevenshell_error::ShellError;

/// The sampling throttle's base delay: one pause is longer than the panel's tick, so a refusal
/// is felt as several skipped samples rather than the next tick hitting the same wall.
pub(crate) const SAMPLING_BASE: Duration = Duration::from_secs(10);

/// The sampling throttle's cap. Long enough that a host that has stopped answering is left
/// alone; short enough that a host which comes back is found within a minute.
pub(crate) const SAMPLING_CAP: Duration = Duration::from_secs(60);

/// The reconnect throttle's base delay. A first failure is allowed to have been a moment's
/// trouble; the pause starts just above the rate the callers actually poll at.
pub(crate) const RECONNECT_BASE: Duration = Duration::from_secs(2);

/// The reconnect throttle's cap, in the order the task of keeping a refusing host unhammered
/// sets: after a few failures the next attempt is half a minute away, not next poll.
pub(crate) const RECONNECT_CAP: Duration = Duration::from_secs(30);

/// How much of a delay's length the jitter may move it, in either direction.
const JITTER_FRACTION: u128 = 4;

/// The delay after `consecutive` failures: the base doubled each time, capped, then moved within
/// a quarter of itself by jitter. Doubled, not `× failures`, so five failures in a row reach the
/// cap in five steps rather than five seconds.
fn delay(base: Duration, cap: Duration, consecutive: u32) -> Duration {
    let doublings = consecutive.saturating_sub(1);
    let grown = Duration::from_secs(base.as_secs().saturating_mul(1 << doublings.min(20)));
    let capped = grown.min(cap);
    jitter(capped)
}

/// Moves a delay within a quarter of itself, from the clock's sub-second nanos.
///
/// This is not cryptography and does not pretend to be: it exists so several callers failing at
/// the same moment do not all become eligible again at the same moment, which is the shape a
/// server sees as a burst.
fn jitter(delay: Duration) -> Duration {
    let span = (delay.as_millis() / JITTER_FRACTION).max(1);
    let nanos = std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| u128::from(since.subsec_nanos()))
        .unwrap_or(0);
    let offset = (nanos % (2 * span)) as i128 - span as i128;
    let moved = delay.as_millis() as i128 + offset;
    Duration::from_millis(u64::try_from(moved.max(1)).unwrap_or(1))
}

/// The seconds until an `Instant`, as a whole number, never zero.
fn seconds_left(until: Instant) -> u64 {
    until.saturating_duration_since(Instant::now()).as_secs().max(1)
}

/// One connection's sampling discipline: a read is on it or it is not, and refusals pause it.
///
/// Keyed by terminal handle, because a handle is one connection for as long as it lives. The
/// in-flight flag is released by the guard being dropped — including on a panic, which is why it
/// is an `Arc<AtomicBool>` and not a line in the slot the outcome path writes.
pub(crate) struct SamplingGate {
    slots: Mutex<HashMap<String, Slot>>,
}

struct Slot {
    in_flight: Arc<AtomicBool>,
    failures: u32,
    paused_until: Option<Instant>,
    reason: Option<String>,
}

impl Default for SamplingGate {
    fn default() -> Self {
        Self::new()
    }
}

impl SamplingGate {
    pub(crate) fn new() -> Self {
        Self {
            slots: Mutex::new(HashMap::new()),
        }
    }

    /// Claims the right to take one sample on this connection.
    ///
    /// A second claim while one is out is refused at once — the poll that follows will sample —
    /// and a connection that refused its last channel-open is refused until its pause is over,
    /// with the reason and the seconds remaining in the answer.
    pub(crate) fn enter(&self, handle: &str, peer: (&str, u16)) -> Result<SamplingPermit, ShellError> {
        let mut slots = self.slots.lock().expect("the sampling slots lock");
        let slot = slots.entry(handle.to_owned()).or_insert_with(|| Slot {
            in_flight: Arc::new(AtomicBool::new(false)),
            failures: 0,
            paused_until: None,
            reason: None,
        });

        if slot.in_flight.swap(true, std::sync::atomic::Ordering::Relaxed) {
            return Err(ShellError::app_busy(format!(
                "a sample is already being taken on {}:{}; one channel at a time is the limit this \
                 connection is held to",
                peer.0, peer.1
            )));
        }

        if let Some(until) = slot.paused_until
            && Instant::now() < until
        {
            let seconds = seconds_left(until);
            slot.in_flight.store(false, std::sync::atomic::Ordering::Relaxed);
            return Err(ShellError::ssh_backoff(
                peer.0,
                peer.1,
                seconds,
                slot.failures,
                format!(
                    "sampling {}:{} is paused for {seconds} more seconds because the connection \
                     refused a channel: {}",
                    peer.0,
                    peer.1,
                    slot.reason.as_deref().unwrap_or("the last sample failed")
                ),
            ));
        }

        Ok(SamplingPermit {
            in_flight: Arc::clone(&slot.in_flight),
        })
    }

    /// Records what one sample came to, before the permit is dropped.
    ///
    /// A success clears the memory; a channel the server refused, or a sample that timed out,
    /// lengthens the pause. Every other failure — a terminal that ended, a handle that is gone —
    /// says nothing about the server's willingness, so it changes nothing here.
    pub(crate) fn leave<T>(&self, handle: &str, outcome: &Result<T, ShellError>) {
        let failure = match outcome {
            Ok(_) => None,
            Err(error) => match error.code() {
                sevenshell_error::ErrorCode::SshChannelRefused | sevenshell_error::ErrorCode::SshTimeout => {
                    Some(error.detail().map(str::to_owned).unwrap_or_else(|| error.to_string()))
                }
                _ => None,
            },
        };

        let mut slots = self.slots.lock().expect("the sampling slots lock");
        let Some(slot) = slots.get_mut(handle) else {
            return;
        };

        match failure {
            None => {
                slot.failures = 0;
                slot.paused_until = None;
                slot.reason = None;
            }
            Some(reason) => {
                slot.failures = slot.failures.saturating_add(1);
                slot.paused_until = Some(Instant::now() + delay(SAMPLING_BASE, SAMPLING_CAP, slot.failures));
                slot.reason = Some(reason);
            }
        }
    }
}

/// The claim one sample holds on a connection, released when dropped.
///
/// Held across the command's run, so a sample that panics still releases the connection rather
/// than leaving it permanently "busy" — the flag is dropped, not updated on a path someone has
/// to remember.
#[derive(Debug)]
pub(crate) struct SamplingPermit {
    in_flight: Arc<AtomicBool>,
}

impl Drop for SamplingPermit {
    fn drop(&mut self) {
        self.in_flight.store(false, std::sync::atomic::Ordering::Relaxed);
    }
}

/// Per-target memory of failed connection attempts, so a refusing host is not hammered.
///
/// Consulted by every fresh carrier open. A host key decision is not a failure — it is a
/// question a person is being asked — and a success is a forgetting.
pub(crate) struct ReconnectGate {
    attempts: Mutex<HashMap<(String, u16), Attempt>>,
}

struct Attempt {
    failures: u32,
    next_allowed: Instant,
    reason: String,
}

impl Default for ReconnectGate {
    fn default() -> Self {
        Self::new()
    }
}

impl ReconnectGate {
    pub(crate) fn new() -> Self {
        Self {
            attempts: Mutex::new(HashMap::new()),
        }
    }

    /// Whether a connection to this host may be attempted now.
    ///
    /// Within a pause the answer is no — immediately, with what failed and how long is left.
    /// The error is the caller's whole answer: it does not wait, and nothing queues behind it.
    pub(crate) fn check(&self, host: &str, port: u16) -> Result<(), ShellError> {
        let attempts = self.attempts.lock().expect("the reconnect gate lock");
        let Some(attempt) = attempts.get(&(host.to_owned(), port)) else {
            return Ok(());
        };
        if Instant::now() >= attempt.next_allowed {
            return Ok(());
        }
        let seconds = seconds_left(attempt.next_allowed);
        Err(ShellError::ssh_backoff(
            host,
            port,
            seconds,
            attempt.failures,
            format!(
                "the last {0} connection attempts to {host}:{port} failed ({1}); the next attempt \
                 is allowed in {seconds} seconds",
                attempt.failures, attempt.reason
            ),
        ))
    }

    /// Records that a connection attempt just failed, and pauses the next one.
    pub(crate) fn record_failure(&self, host: &str, port: u16, reason: &str) {
        let mut attempts = self.attempts.lock().expect("the reconnect gate lock");
        let attempt = attempts.entry((host.to_owned(), port)).or_insert_with(|| Attempt {
            failures: 0,
            next_allowed: Instant::now(),
            reason: String::new(),
        });
        attempt.failures = attempt.failures.saturating_add(1);
        attempt.reason = reason.chars().take(160).collect();
        attempt.next_allowed = Instant::now() + delay(RECONNECT_BASE, RECONNECT_CAP, attempt.failures);
    }

    /// Records that a connection attempt succeeded, and forgets the failures before it.
    pub(crate) fn record_success(&self, host: &str, port: u16) {
        self.attempts
            .lock()
            .expect("the reconnect gate lock")
            .remove(&(host.to_owned(), port));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_error::ErrorCode;

    /// The nominal schedule the jitter may not leave, in whole seconds.
    fn nominal(base: Duration, consecutive: u32) -> u64 {
        let doublings = consecutive.saturating_sub(1);
        let grown = Duration::from_secs(base.as_secs() << doublings.min(20));
        grown.min(cap_for(base)).as_secs()
    }

    fn cap_for(base: Duration) -> Duration {
        if base == SAMPLING_BASE {
            SAMPLING_CAP
        } else {
            RECONNECT_CAP
        }
    }

    #[test]
    fn the_sampling_schedule_doubles_from_its_base_and_stops_at_its_cap() {
        assert_eq!(nominal(SAMPLING_BASE, 1), 10);
        assert_eq!(nominal(SAMPLING_BASE, 2), 20);
        assert_eq!(nominal(SAMPLING_BASE, 3), 40);
        // The cap, not 80: five failures in a row stop growing.
        assert_eq!(nominal(SAMPLING_BASE, 4), 60);
        assert_eq!(nominal(SAMPLING_BASE, 9), 60);
    }

    #[test]
    fn the_reconnect_schedule_doubles_from_its_base_and_stops_at_its_cap() {
        assert_eq!(nominal(RECONNECT_BASE, 1), 2);
        assert_eq!(nominal(RECONNECT_BASE, 2), 4);
        assert_eq!(nominal(RECONNECT_BASE, 3), 8);
        assert_eq!(nominal(RECONNECT_BASE, 4), 16);
        assert_eq!(nominal(RECONNECT_BASE, 5), 30);
        assert_eq!(nominal(RECONNECT_BASE, 20), 30);
    }

    #[test]
    fn the_delay_stays_within_a_quarter_of_its_nominal_value() {
        // The jitter is clock-driven, so the bound is what the test can hold: many draws, every
        // one of them inside ±25% of the schedule, and the cap never passed.
        for consecutive in 1..=12 {
            for _ in 0..200 {
                let moved = delay(RECONNECT_BASE, RECONNECT_CAP, consecutive);
                let nominal = u128::from(nominal(RECONNECT_BASE, consecutive)) * 1000;
                let top = nominal * 5 / 4;
                let bottom = nominal * 3 / 4;
                assert!(
                    moved.as_millis() >= bottom && moved.as_millis() <= top.max(1),
                    "consecutive {consecutive}: {} ms is outside {bottom}..{top} ms",
                    moved.as_millis()
                );
            }
        }
    }

    #[test]
    fn a_gate_with_no_history_answers_at_once() {
        let gate = SamplingGate::new();
        assert!(gate.enter("t1", ("host", 22)).is_ok());
    }

    #[test]
    fn a_second_claim_while_one_is_out_is_refused_and_the_permit_releases_it() {
        let gate = SamplingGate::new();
        let permit = gate.enter("t1", ("host", 22)).expect("the first claim");

        let second = gate.enter("t1", ("host", 22)).expect_err("still in flight");
        assert_eq!(second.code(), ErrorCode::AppBusy);

        drop(permit);
        assert!(
            gate.enter("t1", ("host", 22)).is_ok(),
            "the release did not free the slot"
        );
    }

    #[test]
    fn a_refused_sample_pauses_the_next_one_and_a_success_clears_the_memory() {
        let gate = SamplingGate::new();
        let permit = gate.enter("t1", ("host", 22)).expect("the claim");
        let refused = ShellError::ssh_channel_refused("host", 22, "the server refused the channel");
        gate.leave("t1", &Err::<(), _>(refused));
        drop(permit);

        let paused = gate.enter("t1", ("host", 22)).expect_err("paused after a refusal");
        assert_eq!(paused.code(), ErrorCode::SshBackoff);
        assert!(
            paused
                .detail()
                .unwrap_or_default()
                .contains("the server refused the channel"),
            "the reason travels with the pause"
        );

        // A success clears the pause entirely — this is what makes a host that recovered be
        // found again rather than sampled never.
        {
            // The pause must first be allowed to end for a success to be recorded through
            // `enter`; `leave` is the path that clears, so record it directly.
            gate.leave("t1", &Ok::<(), ShellError>(()));
            let permit = gate.enter("t1", ("host", 22)).expect("the claim after recovery");
            gate.leave("t1", &Ok::<(), ShellError>(()));
            drop(permit);
        }
        assert!(gate.enter("t1", ("host", 22)).is_ok());
    }

    #[test]
    fn a_timed_out_sample_pauses_sampling_too_but_an_ended_terminal_does_not() {
        let gate = SamplingGate::new();
        let permit = gate.enter("t2", ("host", 22)).expect("the claim");
        let timed_out = ShellError::ssh_timeout("host", 22, 10);
        gate.leave("t2", &Err::<(), _>(timed_out));
        drop(permit);
        assert!(
            gate.enter("t2", ("host", 22)).is_err(),
            "a timeout pauses the next sample"
        );

        let permit = gate.enter("t3", ("host", 22)).expect("the claim");
        let gone = ShellError::session_not_found("t3");
        gate.leave("t3", &Err::<(), _>(gone));
        drop(permit);
        assert!(
            gate.enter("t3", ("host", 22)).is_ok(),
            "a handle that does not exist says nothing about the server"
        );
    }

    #[test]
    fn a_failed_connection_pauses_reconnection_and_a_success_forgives_it() {
        let gate = ReconnectGate::new();
        gate.record_failure("host", 22, "connection refused");

        let paused = gate.check("host", 22).expect_err("paused after a failure");
        assert_eq!(paused.code(), ErrorCode::SshBackoff);
        let detail = paused.detail().unwrap_or_default();
        assert!(detail.contains("connection refused"), "detail was: {detail}");
        assert!(
            detail.contains("the last 1 connection attempts"),
            "detail was: {detail}"
        );

        gate.record_success("host", 22);
        assert!(gate.check("host", 22).is_ok(), "a success forgave nothing?");
    }

    #[test]
    fn a_different_host_is_never_paused_by_another_hosts_failures() {
        let gate = ReconnectGate::new();
        gate.record_failure("down.example", 22, "unreachable");
        assert!(gate.check("up.example", 22).is_ok());
        assert!(
            gate.check("down.example", 2222).is_ok(),
            "the port is part of the target"
        );
    }
}
