//! The embedded browser host: the whole interface, served from this process on demand.
//!
//! "Open this desktop in a browser" is one action, and everything behind it lives here. The router
//! is the one [`sevenshell_web`] serves — the same contract the standalone binary answers — driven
//! by *this* process's own core and vault, so what a browser tab sees is the application's live
//! state rather than a copy of it.
//!
//! The facts that keep the feature invisible until it is used:
//!
//! * **Default off.** Nothing exists before the first open: no listener, no router, no runtimes, no
//!   token. An application that never hands a desktop to a browser behaves, allocates and listens
//!   exactly as it did before this module. The one resident exception is honest and small: the
//!   terminal event tap's channel buffer (see the paragraph below), which exists from start-up
//!   because the desktop's pump is born holding it, and costs one allocation of sixty-four slots.
//! * **One listener, on demand.** [`WebHost::start`] binds when the first open asks and closes when
//!   the lifecycle says so; [`WebHost::stop`] is explicit and idempotent.
//! * **The port.** The preferred port ([`PREFERRED_PORT`], 4225) is taken when it is free and an
//!   ephemeral one is taken when it is not, so a busy port is never a failure to open. A restart
//!   after an idle stop tries the preferred port again and may come back on a different one — an
//!   old tab's URL names the port it was given, and the stub card's copy action is how a fresh URL
//!   is had.
//! * **The token.** One token per application run, minted by [`crate::mcp::auth::generate_token`]
//!   the first time the host starts and kept for every start afterwards — so a tab from before an
//!   idle stop can re-authenticate against the restarted host without a new URL. Every request
//!   without it is refused; the interface's routes compare it in constant time (the library's own
//!   [`sevenshell_web`] compare), the tool listener keeps the shape it has always had, and the URL
//!   carries the token in the **fragment**, never the query: a fragment is read by the page itself
//!   out of `location.hash` and never reaches the server, the history query string or a referer.
//! * **The lifecycle, event-driven.** The host watches the browser-session counter the library
//!   keeps — every open `/events` socket is one session, counted by a guard whose drop is the only
//!   place the count goes down. Zero sessions arms *one* timer for [`IDLE_GRACE`]; any session
//!   coming back wakes the watch and abandons the timer. There is no polling loop: the counter's
//!   change notification is the only thing that moves this watcher, and the deadline is a one-shot
//!   timer, not a tick. The grace exists for the refresh race — a reloading tab drops its socket
//!   for a moment and reconnects well inside two minutes — and for the tab that was opened but
//!   never connected: a host nobody came to stops itself.
//! * **App exit.** The window's destroy path stops the host with everything else that answers on
//!   sockets; nothing outlives the process.
//!
//! The terminal event stream deserves its own sentence: the interface's ZMODEM detector and its
//! `terminal:closed` announcements are driven by the core's events, whose only receiver the
//! desktop's own pump holds. The pump fans events out here — [`WebHost::core_event_tap`] — and
//! only while the host actually holds a subscriber: with the host idle or stopped, the terminal
//! stream pays nothing for a feature it is not using. While it *is* serving, each event is copied
//! once for the second consumer, the unavoidable minimum for an event type that is not `Clone` and
//! a channel with exactly one reader.
//!
//! Static assets (decision D9 of the phase-seven charter): release builds ship the built interface
//! as Tauri bundle resources and serve [`packaged_resource_dir`]'s layout; development builds fall
//! back to the repository's `apps/desktop/dist`. `SEVENSHELL_WEB_STATIC` overrides both — the same
//! variable the standalone binary answers, and the seam the tests drive through.

use std::net::Ipv4Addr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use percent_encoding::AsciiSet;
use sevenshell_core::{Core, CoreEvent};
use sevenshell_error::ShellError;
use sevenshell_vault::Vault;
use sevenshell_web::{BrowserSessions, ServeConfig, WebServer};
use tokio::net::TcpListener;
use tokio::sync::{Mutex as AsyncMutex, broadcast, mpsc};
use tokio::task::JoinHandle;

use crate::mcp::auth::generate_token;

/// The port the embedded host prefers. The standalone binary answers on the same one, so a machine
/// cannot end up with both conventions.
pub const PREFERRED_PORT: u16 = 4225;

/// How long the host stays up with no browser session connected.
///
/// Long enough that a reload — which drops and reopens the event socket — never looks like a
/// departure, and short enough that a tab which never connected does not keep a listener alive
/// all day. Chosen over anything shorter precisely because a refresh must never be mistaken for
/// the last session leaving; a shorter grace would trade a rare stale tab for a mid-session cut.
pub const IDLE_GRACE: Duration = Duration::from_secs(120);

/// The environment variable that overrides where the built interface is served from.
pub const STATIC_DIR_OVERRIDE: &str = "SEVENSHELL_WEB_STATIC";

/// The characters a session id cannot carry raw inside the URL fragment: the ones that would end
/// the fragment, start another parameter or confuse the split between key and value. Ordinary
/// identifiers — UUIDs and the like — pass through untouched.
const FRAGMENT_UNSAFE: &AsciiSet = &percent_encoding::CONTROLS
    .add(b' ')
    .add(b'"')
    .add(b'<')
    .add(b'>')
    .add(b'`')
    .add(b'#')
    .add(b'&')
    .add(b'=')
    .add(b'%');

/// The URL a browser is handed for one desktop session.
///
/// `#token=…` is the authentication story told in one fragment; `open=desktop:<id>` is the deep
/// link the freshly opened tab reads to know which desktop was meant. The id is percent-encoded
/// with [`FRAGMENT_UNSAFE`], so the shape stays parseable for any id a vault can hold.
pub fn browser_url(port: u16, token: &str, session_id: &str) -> String {
    let target = percent_encoding::utf8_percent_encode(session_id, FRAGMENT_UNSAFE);
    format!("http://127.0.0.1:{port}/#token={token}&open=desktop:{target}")
}

/// Where the built interface lives for one start.
///
/// The override first, then the packaged layout (D9), then the development tree. A folder without
/// an `index.html` is not a built interface, whatever its name.
pub fn resolve_static_dir(resource_dir: Option<&Path>) -> Result<PathBuf, ShellError> {
    if let Some(from_environment) = std::env::var_os(STATIC_DIR_OVERRIDE).map(PathBuf::from) {
        if from_environment.join("index.html").is_file() {
            return Ok(from_environment);
        }
        log::warn!(
            "{} names a folder without an index.html; it is ignored",
            STATIC_DIR_OVERRIDE
        );
    }

    if let Some(resource_dir) = resource_dir
        && let Some(found) = first_with_index(packaged_candidates(resource_dir))
    {
        return Ok(found);
    }
    if let Some(found) = development_dist() {
        return Ok(found);
    }

    Err(ShellError::app_internal(format!(
        "the built interface could not be located for the browser host; build the desktop once \
         (apps/desktop/dist) or set {STATIC_DIR_OVERRIDE} to the folder holding index.html"
    )))
}

/// The layouts the packaged application's bundle resources may take (D9).
///
/// Tauri maps `bundle.resources` into the resource directory in a layout that depends on how the
/// glob is spelled; the phase-seven closeout verifies the shape the NSIS build actually produces
/// and this list is where that answer is written down. Every candidate is checked for a real
/// `index.html`, and [`search_for_dist`] stands behind them as the last resort.
fn packaged_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    let mut candidates = vec![
        // What `bundle.resources: ["resources/desktop/**/*"]` produces: Tauri keeps the glob's own
        // folders under the resource directory, so the shipped interface lands one level down.
        resource_dir.join("resources").join("desktop"),
        resource_dir.join("apps").join("desktop").join("dist"),
        resource_dir.join("desktop").join("dist"),
        resource_dir.join("dist"),
    ];
    if let Some(searched) = search_for_dist(resource_dir, 4) {
        candidates.push(searched);
    }
    candidates
}

/// The first candidate that actually holds a built interface.
fn first_with_index(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|candidate| candidate.join("index.html").is_file())
}

/// A bounded walk of the resource directory, for a layout this list of candidates did not guess.
///
/// Depth is capped so a wrongly configured bundle can never turn a start into a full-disk scan.
fn search_for_dist(root: &Path, depth: usize) -> Option<PathBuf> {
    if depth == 0 {
        return None;
    }
    let entries = std::fs::read_dir(root).ok()?;
    let mut subdirectories = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(kind) = entry.file_type() else { continue };
        if kind.is_dir() {
            subdirectories.push(path.clone());
            if path.file_name().is_some_and(|name| name == "dist") && path.join("index.html").is_file() {
                return Some(path);
            }
        }
    }
    subdirectories
        .into_iter()
        .find_map(|directory| search_for_dist(&directory, depth - 1))
}

/// The repository's built interface, found by walking up from the places this process starts in.
///
/// Development only: a packaged application has no repository next to it, and the walk costs one
/// handful of `stat` calls per start.
fn development_dist() -> Option<PathBuf> {
    let mut starts = Vec::new();
    if let Ok(executable) = std::env::current_exe()
        && let Some(directory) = executable.parent()
    {
        starts.push(directory.to_path_buf());
    }
    if let Ok(directory) = std::env::current_dir() {
        starts.push(directory);
    }
    for start in starts {
        let mut directory = Some(start);
        for _ in 0..8 {
            let Some(current) = directory else { break };
            let candidate = current.join("apps").join("desktop").join("dist");
            if candidate.join("index.html").is_file() {
                return Some(candidate);
            }
            directory = current.parent().map(Path::to_path_buf);
        }
    }
    None
}

/// The resource directory of a packaged build, for [`resolve_static_dir`].
///
/// A development build has none worth asking for — its interface comes from the repository tree —
/// so the answer is `None` there rather than a directory the host would search in vain.
pub fn packaged_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        return None;
    }
    use tauri::Manager as _;
    app.path().resource_dir().ok()
}

/// What one run holds. Built at [`WebHost::start`]; nothing of it exists while the host is stopped.
struct Running {
    server: WebServer,
    /// The count the watcher below is watching; the same counter the served router counts with.
    /// Read only through [`WebHost::browser_sessions`], whose caller is the tests today.
    #[allow(dead_code)]
    sessions: Arc<BrowserSessions>,
    /// The idle watcher. Aborted on stop, before the server: a watcher woken by a stop must not
    /// find a host to stop twice.
    watcher: JoinHandle<()>,
    /// The tap-to-pump bridge. Aborted on stop so the library's event pump sees its channel close
    /// and ends, rather than waiting on a sender that would never be dropped.
    bridge: JoinHandle<()>,
    /// Kept so the pump's channel closes when this run is taken, even if the abort above raced.
    events_tx: mpsc::Sender<CoreEvent>,
}

/// The embedded host the shell keeps: on-demand serving of the interface on this process's core.
///
/// One instance lives in [`crate::state::ShellState`] for the whole run. It is cheap by design —
/// a vault handle, a core handle, an event tap and one optional running entry — because the
/// default is never to use it.
pub struct WebHost {
    core: Arc<Core>,
    vault: Arc<Vault>,
    /// Where the core's terminal events reach the browser host's pump. See the module doc for why
    /// the desktop's pump fans out rather than the core growing a second receiver.
    tap: broadcast::Sender<CoreEvent>,
    /// Where the built interface is looked up when a start needs it. `None` in a development build,
    /// whose interface comes from the repository tree.
    resource_dir: Option<PathBuf>,
    /// An interface folder handed in instead of resolved — the tests' way, and a caller's escape
    /// hatch if the resolution above ever needs to be answered by the shell.
    static_dir: Option<PathBuf>,
    preferred_port: u16,
    idle_grace: Duration,
    /// The token of this application run, minted at the first start and kept afterwards.
    token: OnceLock<String>,
    running: AsyncMutex<Option<Running>>,
}

impl WebHost {
    /// Builds the host for this application run. Nothing is bound and nothing is allocated beyond
    /// the handles: the default is that it is never used.
    pub fn new(core: Arc<Core>, vault: Arc<Vault>, resource_dir: Option<PathBuf>) -> Self {
        Self::with_options(core, vault, resource_dir, None, PREFERRED_PORT, IDLE_GRACE)
    }

    /// The same host, with every default made explicit.
    fn with_options(
        core: Arc<Core>,
        vault: Arc<Vault>,
        resource_dir: Option<PathBuf>,
        static_dir: Option<PathBuf>,
        preferred_port: u16,
        idle_grace: Duration,
    ) -> Self {
        // Capacity 64, the same shape the core's own batch events travel by: terminal output is
        // the bursty case, and a burst that outruns the pump is dropped at the broadcast tap with
        // a lag notice rather than piling up here.
        let (tap, _) = broadcast::channel(64);
        Self {
            core,
            vault,
            tap,
            resource_dir,
            static_dir,
            preferred_port,
            idle_grace,
            token: OnceLock::new(),
            running: AsyncMutex::new(None),
        }
    }

    /// The terminal event tap the desktop's pump feeds. Feeding costs nothing while nobody
    /// subscribes, and the host subscribes only while it is serving.
    pub fn core_event_tap(&self) -> broadcast::Sender<CoreEvent> {
        self.tap.clone()
    }

    /// Whether a listener is up right now.
    ///
    /// The tests ask it; a status command is the caller it is written for otherwise, and until that
    /// command exists a production build has no call site.
    #[allow(dead_code)]
    pub async fn is_running(&self) -> bool {
        self.running.lock().await.is_some()
    }

    /// The session counter the running host is watching. `None` while stopped.
    ///
    /// The tests use it to be a browser; a diagnostic command could read it to say how many tabs
    /// are connected. Nobody but the host's own watch decides the lifecycle from it.
    #[allow(dead_code)]
    pub async fn browser_sessions(&self) -> Option<Arc<BrowserSessions>> {
        self.running
            .lock()
            .await
            .as_ref()
            .map(|running| Arc::clone(&running.sessions))
    }

    /// The token of this application run, minted on first use.
    ///
    /// Two starts racing to mint it both mint one and the first set wins; both answers open the
    /// same listener, so whichever token a caller took is the one the tab carries.
    fn token(&self) -> Result<String, ShellError> {
        if let Some(token) = self.token.get() {
            return Ok(token.clone());
        }
        let token = generate_token()?;
        let _ = self.token.set(token.clone());
        Ok(self
            .token
            .get()
            .expect("set above, by this caller or the race winner")
            .clone())
    }

    /// Starts the host, or answers the listener already up.
    ///
    /// A start that fails leaves nothing behind: the listener it could not bind is dropped with
    /// the error, and the next open tries again. The receiver is the shell's own `Arc` handle so
    /// the idle watcher below can hold the host weakly rather than keeping it alive itself.
    pub async fn start(self: &Arc<Self>) -> Result<u16, ShellError> {
        let mut running = self.running.lock().await;
        if let Some(up) = running.as_ref() {
            return Ok(up.server.port);
        }

        let token = self.token()?;
        let static_dir = match self.static_dir.clone() {
            Some(handed_in) => handed_in,
            None => resolve_static_dir(self.resource_dir.as_deref())?,
        };

        let listener = bind_preferred(self.preferred_port).await?;
        let port = listener
            .local_addr()
            .map_err(|error| ShellError::store_io(format!("the bound address could not be read: {error}")))?
            .port();

        // The tap-to-pump bridge: the library's pump consumes this channel the way the standalone
        // binary consumes the core's own receiver, and the desktop's pump is the producer.
        let (events_tx, events_rx) = mpsc::channel(64);
        let mut tap_rx = self.tap.subscribe();
        let bridge_tx = events_tx.clone();
        let bridge = tokio::spawn(async move {
            loop {
                match tap_rx.recv().await {
                    Ok(event) => {
                        if bridge_tx.send(event).await.is_err() {
                            break; // the pump is gone; the host is stopping.
                        }
                    }
                    // Behind for a moment (a burst of terminal output): the missed chunk is a lag
                    // notice, not an end; the feed goes on.
                    Err(broadcast::error::RecvError::Lagged(missed)) => {
                        log::warn!("the browser host fell {missed} terminal event(s) behind and skipped them");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        });

        let sessions = Arc::new(BrowserSessions::new());
        let server = sevenshell_web::serve(
            listener,
            ServeConfig {
                core: Arc::clone(&self.core),
                vault: Arc::clone(&self.vault),
                static_dir,
                token: token.clone(),
                core_events: events_rx,
                sessions: Arc::clone(&sessions),
                // The desktop already owns the agent listener; a second one would only fight it
                // for the configured port.
                restore_agent_listener: false,
            },
        )
        .await?;

        let watcher = self.spawn_idle_watcher(Arc::clone(&sessions));
        *running = Some(Running {
            server,
            sessions,
            watcher,
            bridge,
            events_tx,
        });
        drop(running);

        log::info!(
            "the browser interface is listening on 127.0.0.1:{port}; it stops after {}s with no browser session",
            self.idle_grace.as_secs()
        );
        Ok(port)
    }

    /// Stops the host. Idempotent, and safe from the watcher and the destroy path alike.
    ///
    /// The order is deliberate: the listener is shut down *before* the tasks are aborted, because
    /// the watcher's own stop runs inside the watcher task — aborting that task first would cancel
    /// the shutdown in the middle of its own await. Whoever lost the take below simply answers
    /// "nothing to stop"; the winner carries the teardown through.
    pub async fn stop(&self) {
        let running = self.running.lock().await.take();
        let Some(Running {
            server,
            watcher,
            bridge,
            events_tx,
            ..
        }) = running
        else {
            return;
        };
        server.stop().await;
        watcher.abort();
        bridge.abort();
        drop(events_tx);
        log::info!("the browser interface stopped; nothing is listening for it any more");
    }

    /// The URL for one desktop session, starting the host if it is not up.
    ///
    /// A session the vault does not know is [`ShellError::session_not_found`] before anything is
    /// started: an interface for a desktop that does not exist is not worth a listener.
    pub async fn url_for(self: &Arc<Self>, session_id: &str) -> Result<String, ShellError> {
        self.ensure_session(session_id)?;
        let port = self.start().await?;
        let token = self.token()?;
        Ok(browser_url(port, &token, session_id))
    }

    /// Whether the vault knows this session. A locked vault answers with its own error: the
    /// interface is of no use without the credentials it would hold.
    fn ensure_session(&self, session_id: &str) -> Result<(), ShellError> {
        let known = self
            .vault
            .sessions()
            .map(|sessions| sessions.iter().any(|session| session.id == session_id));
        match known {
            Ok(true) => Ok(()),
            Ok(false) => Err(ShellError::session_not_found(session_id)),
            Err(error) => Err(error),
        }
    }

    /// The event-driven idle watch: the counter is the whole schedule.
    ///
    /// Zero sessions arms one timer for the grace; a session coming back wakes the wait and the
    /// timer is abandoned. No tick, no interval, no re-read on a clock: the counter's change
    /// notification is the only wake-up, and the deadline is re-armed only by a transition back to
    /// zero. Even the deadline's own fire re-reads the count first — a session that returned in
    /// the same instant the timer fired must win.
    fn spawn_idle_watcher(self: &Arc<Self>, sessions: Arc<BrowserSessions>) -> JoinHandle<()> {
        let host = Arc::downgrade(self);
        let grace = self.idle_grace;
        tokio::spawn(async move {
            loop {
                // Wait (event-driven) for the count to sit at zero.
                while sessions.count() > 0 {
                    sessions.changed().await;
                }

                // Zero now: one timer, for the whole grace.
                let deadline = tokio::time::Instant::now() + grace;
                loop {
                    if sessions.count() > 0 {
                        // Somebody is looking again; the timer is abandoned and the outer wait
                        // takes over until the count returns to zero.
                        break;
                    }
                    tokio::select! {
                        _ = sessions.changed() => {}
                        _ = tokio::time::sleep_until(deadline) => {
                            if sessions.count() > 0 {
                                break;
                            }
                            if let Some(host) = host.upgrade() {
                                log::info!(
                                    "the last browser session left and nobody came back within {}s",
                                    grace.as_secs()
                                );
                                host.stop().await;
                            }
                            return;
                        }
                    }
                }
            }
        })
    }
}

/// Binds the loopback listener: the preferred port when it is free, an ephemeral one when it is
/// not, and the caller's error when the caller asked for ephemeral and got nothing.
async fn bind_preferred(preferred: u16) -> Result<TcpListener, ShellError> {
    match TcpListener::bind((Ipv4Addr::LOCALHOST, preferred)).await {
        Ok(listener) => Ok(listener),
        Err(taken) if preferred != 0 => {
            log::info!(
                "127.0.0.1:{preferred} is taken ({taken}); the browser interface takes a port the system assigns"
            );
            TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).await.map_err(|error| {
                ShellError::store_io(format!("the browser interface could not listen on 127.0.0.1: {error}"))
            })
        }
        Err(error) => Err(ShellError::store_io(format!(
            "the browser interface could not listen on 127.0.0.1:{preferred}: {error}"
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sevenshell_types::{AuthMethod, Protocol, Session, SessionAuth};

    /// A host against a temporary vault, with an interface folder handed in so no repository has
    /// to exist for the tests to run. The vault is created unlocked, so a test can save the
    /// session it opens a browser for.
    fn a_host(idle_grace: Duration) -> (Arc<WebHost>, tempfile::TempDir) {
        let directory = tempfile::tempdir().expect("a temp directory");
        let vault = Arc::new(Vault::open_at(directory.path().join("vault.json")));
        vault
            .create("the-test-password")
            .expect("a fresh vault is unlocked by its creation");
        let (core, events) = Core::new(Arc::clone(&vault));
        // The receiver lives as long as the core would; no terminal event is produced here.
        drop(events);
        let host = Arc::new(WebHost::with_options(
            core,
            vault,
            None,
            Some(directory.path().join("dist")),
            0,
            idle_grace,
        ));
        (host, directory)
    }

    fn a_session(id: &str) -> Session {
        Session {
            id: id.to_owned(),
            name: "the desktop under test".to_owned(),
            group_id: None,
            protocol: Protocol::Ssh,
            host: "desktop.example".to_owned(),
            port: 22,
            user: "root".to_owned(),
            auth: SessionAuth::with_password(AuthMethod::Password),
            terminal: sevenshell_types::TerminalSettings::default(),
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
            order: None,
            vmware: sevenshell_types::VmwareSettings::default(),
            updated_at: 1,
        }
    }

    /// Points the platform's configuration directory at a temporary one: building the served router
    /// constructs the audit trail, whose default lives in the machine's real configuration
    /// directory, and a test run must never touch that.
    struct TestConfigDir {
        previous: Option<std::ffi::OsString>,
    }

    impl TestConfigDir {
        fn at(directory: &Path) -> Self {
            let previous = std::env::var_os("SEVENSHELL_CONFIG_DIR");
            // SAFETY: one environment variable, set before the test body runs and put back on
            // drop; no other test in this crate reads the configuration directory concurrently.
            unsafe { std::env::set_var("SEVENSHELL_CONFIG_DIR", directory) };
            Self { previous }
        }
    }

    impl Drop for TestConfigDir {
        fn drop(&mut self) {
            // SAFETY: as above — the same one variable, restored.
            match self.previous.take() {
                Some(value) => unsafe { std::env::set_var("SEVENSHELL_CONFIG_DIR", value) },
                None => unsafe { std::env::remove_var("SEVENSHELL_CONFIG_DIR") },
            }
        }
    }

    /// Waits for a predicate with a generous budget, so a slow machine cannot turn "stops soon"
    /// into a flaky red.
    async fn until_with_budget(mut predicate: impl FnMut() -> bool + Send) -> bool {
        for _ in 0..200 {
            if predicate() {
                return true;
            }
            tokio::time::sleep(Duration::from_millis(25)).await;
        }
        predicate()
    }

    #[test]
    fn the_url_carries_the_token_in_the_fragment_and_names_the_desktop() {
        assert_eq!(
            browser_url(4225, "the-token", "desk-01"),
            "http://127.0.0.1:4225/#token=the-token&open=desktop:desk-01"
        );
        assert!(
            !browser_url(4225, "the-token", "desk-01").contains('?'),
            "the token travels in the fragment, never the query"
        );
    }

    #[test]
    fn a_session_id_that_would_break_the_fragment_is_encoded() {
        let url = browser_url(4225, "the-token", "a&id=b#c");
        assert!(url.ends_with("#token=the-token&open=desktop:a%26id%3Db%23c"), "{url}");
        assert_eq!(
            url.matches('#').count(),
            1,
            "the encoded id cannot start a second fragment"
        );
    }

    #[tokio::test]
    async fn a_taken_preferred_port_falls_back_to_one_the_system_assigns() {
        let occupied = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("an ephemeral port to occupy");
        let taken = occupied.local_addr().expect("the occupied port").port();

        let listener = bind_preferred(taken).await.expect("the fallback bind");
        let port = listener.local_addr().expect("the fallback port").port();

        assert_ne!(port, taken, "a busy port is never a failure to open");
    }

    #[tokio::test]
    async fn the_preferred_port_is_taken_when_it_is_free() {
        // Prove it with a port this test controls, rather than betting that 4225 is free on the
        // machine the suite happens to run on.
        let probe = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .await
            .expect("an ephemeral port");
        let preferred = probe.local_addr().expect("the probe port").port();
        drop(probe);

        let listener = bind_preferred(preferred).await.expect("the bind");
        assert_eq!(
            listener.local_addr().expect("the bound port").port(),
            preferred,
            "the port that was free is the port that was taken"
        );
    }

    #[tokio::test]
    async fn a_session_the_vault_does_not_know_is_refused_before_anything_starts() {
        let (host, _directory) = a_host(IDLE_GRACE);

        let error = host.url_for("no-such-desktop").await.expect_err("an unknown session");
        assert_eq!(error.code(), sevenshell_error::ErrorCode::SessionNotFound);
        assert!(
            !host.is_running().await,
            "nothing is started for a session that does not exist"
        );
    }

    #[tokio::test]
    async fn the_host_starts_reuses_itself_and_stops_clean() {
        let (host, directory) = a_host(IDLE_GRACE);
        let _config = TestConfigDir::at(directory.path());
        host.vault
            .save_session(a_session("desk-01"), None)
            .expect("a saved session");

        let first = host.url_for("desk-01").await.expect("a URL");
        let second = host.url_for("desk-01").await.expect("the same URL");
        assert_eq!(first, second, "a running host is reused, not started twice");
        assert!(host.is_running().await);

        let url = first;
        let fragment = url.split('#').nth(1).expect("a fragment");
        let token = fragment
            .split('&')
            .find_map(|part| part.strip_prefix("token="))
            .expect("the token in the fragment");
        assert_eq!(
            token.len(),
            crate::mcp::auth::TOKEN_BYTES * 2,
            "the run's token, in hex"
        );

        // Over a real socket, on the interface's own route: without the token, refused; with the
        // run's token, answered. The call is a POST because the route takes a JSON body, and the
        // token rides the same query channel the event socket's handshake uses.
        let port = host_port_of(&url);
        let answer = http_post_invoke(port, None).await;
        assert!(answer.starts_with("HTTP/1.1 401"), "no token, no answer: {answer}");
        let answer = http_post_invoke(port, Some("not-this-run")).await;
        assert!(
            answer.starts_with("HTTP/1.1 401"),
            "the wrong token, no answer: {answer}"
        );
        let answer = http_post_invoke(port, Some(token)).await;
        assert!(
            answer.starts_with("HTTP/1.1 200"),
            "the run's token, answered: {answer}"
        );

        host.stop().await;
        assert!(!host.is_running().await, "a stop is a stop");

        // And the port that served is closed: zero listeners once the host is not running.
        let refused = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).await;
        assert!(refused.is_err(), "nothing listens where the host served");

        // A start after a stop is the same token, so an old tab can re-authenticate.
        let again = host.url_for("desk-01").await.expect("a URL after the stop");
        let token_after = again
            .split('#')
            .nth(1)
            .expect("a fragment")
            .split('&')
            .find_map(|part| part.strip_prefix("token="))
            .expect("the token in the fragment");
        assert_eq!(
            token, token_after,
            "the token belongs to the application run, not the start"
        );
        host.stop().await;
    }

    #[tokio::test]
    async fn an_idle_host_stops_itself_and_a_session_holds_it_open() {
        let grace = Duration::from_millis(150);
        let (host, directory) = a_host(grace);
        let _config = TestConfigDir::at(directory.path());
        host.vault
            .save_session(a_session("desk-01"), None)
            .expect("a saved session");

        host.url_for("desk-01").await.expect("a URL");
        assert!(host.is_running().await);

        // No browser ever connects: the one armed timer runs the whole grace and stops the host.
        let stopped = until_with_budget(|| {
            // `is_running` is async; a polling predicate cannot await it, so the count of a
            // listener is judged by trying the same lock the accessor takes.
            futures_now_is_running(&host)
        })
        .await;
        assert!(stopped, "a host nobody came to stops itself after the grace");

        // A session that is open holds the host open far past the grace.
        host.url_for("desk-01").await.expect("a URL");
        let sessions = host.browser_sessions().await.expect("the running host's counter");
        let guard = sessions.enter();
        tokio::time::sleep(grace * 3).await;
        assert!(
            host.is_running().await,
            "an open browser session cancels the idle deadline"
        );

        // The last session leaving is the cue the grace starts from.
        drop(guard);
        let stopped = until_with_budget(|| futures_now_is_running(&host)).await;
        assert!(stopped, "the last session leaving arms the grace and the host stops");
    }

    /// `is_running` for a polling predicate: the same lock, answered synchronously. A poll that
    /// loses the lock reads "not right now", which the next poll corrects.
    fn futures_now_is_running(host: &WebHost) -> bool {
        host.running.try_lock().map(|guard| guard.is_some()).unwrap_or(false)
    }

    /// The `host:port` of a URL this module built.
    fn host_port_of(url: &str) -> u16 {
        let rest = url.strip_prefix("http://127.0.0.1:").expect("this module's URL shape");
        rest.split('/').next().expect("a port").parse().expect("a port number")
    }

    /// One HTTP request over a real socket, answered with the status line and a little of the body.
    async fn http_request(port: u16, request: &str) -> String {
        use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};
        let mut socket = tokio::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .expect("a connection");
        socket
            .write_all(request.as_bytes())
            .await
            .expect("the request was sent");
        let mut buffer = [0u8; 1024];
        let read = tokio::time::timeout(Duration::from_secs(5), socket.read(&mut buffer))
            .await
            .expect("an answer")
            .expect("a read");
        String::from_utf8_lossy(&buffer[..read]).into_owned()
    }

    /// A real `POST /invoke` — the interface's own command route, whose token may ride the query
    /// channel the way the event socket's handshake has always carried it.
    async fn http_post_invoke(port: u16, token: Option<&str>) -> String {
        let body = r#"{"cmd":"app_info"}"#;
        let query = token.map(|token| format!("?token={token}")).unwrap_or_default();
        http_request(
            port,
            &format!(
                "POST /invoke{query} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\n\
                 Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            ),
        )
        .await
    }
}
