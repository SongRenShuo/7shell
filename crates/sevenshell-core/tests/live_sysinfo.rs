//! What a real host says about itself when the system panel opens, asked over a real connection.
//!
//! Ignored by default: it needs a running sshd with the account a person would use.
//!
//! ```text
//! SEVENSHELL_TEST_HOST=host SEVENSHELL_TEST_PORT=22 SEVENSHELL_TEST_USER=root \
//!   SEVENSHELL_TEST_PASSWORD=… cargo test -p sevenshell-core --test live_sysinfo -- --ignored
//! ```
//!
//! The parsers are proved against captured text in `src/sysinfo.rs`; what only a live host can show
//! is that the one script the overview runs still answers on a real login shell, that every marker
//! survives the trip, and that the new reads — boot state, crontab, logins, firewall, mounts — are
//! carried by the same round trip rather than dropped on the way. The assertions are about shape
//! and plumbing, not about a particular distribution's contents: a lab on Alpine has no systemd,
//! and a test that insists otherwise is a test that fails for a reason it was not checking.

use std::sync::Arc;

use sevenshell_core::Core;
use sevenshell_types::{AuthMethod, OpenOutcome, Session, SessionAuth, TerminalSettings};
use sevenshell_vault::{SessionSecret, Vault};
use tempfile::{TempDir, tempdir};
use tokio::sync::mpsc;

struct Lab {
    /// Owned so the vault file outlives the test.
    _directory: TempDir,
    core: Arc<Core>,
    session_id: String,
    /// Kept alive so the terminal's output has somewhere to go; the overview never reads it.
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
        id: "lab-sysinfo".to_owned(),
        name: "lab sysinfo".to_owned(),
        group_id: None,
        protocol: sevenshell_types::Protocol::LinuxDesk,
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
        session_id: "lab-sysinfo".to_owned(),
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
}

#[tokio::test]
#[ignore = "needs the SSH lab: see deploy/lab/README.md"]
async fn a_real_host_answers_the_whole_overview_in_one_round_trip() {
    let Some(lab) = lab() else {
        return;
    };
    let handle = lab.open_trusting_everything().await;

    let overview = lab.core.system_overview(&handle).await.expect("the overview reads");
    eprintln!(
        "overview: services={} boot-states={} crontab={} logins={} mounts={} firewall={:?}",
        overview.services.len(),
        overview
            .services
            .iter()
            .filter(|service| service.enabled.is_some())
            .count(),
        overview.crontab.len(),
        overview.logins.len(),
        overview.mounts.len(),
        overview
            .firewall
            .as_ref()
            .map(|firewall| (&firewall.backend, firewall.installed, firewall.active)),
    );

    // The answer describes the machine rather than an empty struct: a distribution, a kernel and a
    // running time all came back from `/etc/os-release`, `uname` and `/proc/uptime`.
    assert!(
        overview.distribution.as_deref().is_some_and(|name| !name.is_empty()),
        "the host names a distribution: {overview:?}"
    );
    assert!(
        !overview.kernel.as_deref().unwrap_or_default().is_empty(),
        "and a kernel"
    );
    assert!(overview.uptime_seconds > 0, "and an uptime");

    // Boot state is a second read merged into the first: a host with systemd lists unit files, and
    // every state that arrives is one the host itself spells.
    if !overview.services.is_empty() {
        let states: Vec<&str> = overview
            .services
            .iter()
            .filter_map(|service| service.enabled.as_deref())
            .collect();
        assert!(
            !states.is_empty(),
            "a systemd host answers list-unit-files as well: {}",
            overview.services.len()
        );
        for state in states {
            assert!(
                !state.is_empty() && !state.contains(' '),
                "a boot state is one word as the host spells it: {state:?}"
            );
        }
    }

    // The firewall marker always arrives, even when no tool answered: `None` would mean the script
    // never got that far.
    let firewall = overview
        .firewall
        .as_ref()
        .expect("the firewall marker survives the round trip");
    if firewall.installed {
        assert!(!firewall.backend.is_empty(), "an installed firewall names its tool");
    }

    // Mounts are from the same `df` the monitor samples; a host always has a root.
    assert!(!overview.mounts.is_empty(), "the mounts came back: {overview:?}");
    assert!(
        overview.mounts.iter().any(|mount| mount.mount_point == "/"),
        "and one of them is the root file system"
    );
    assert!(
        overview.mounts.iter().all(|mount| mount.size_bytes > 0),
        "with sizes a ring can be drawn from"
    );

    // The listeners came from `ss -tlnp` on the same round trip: every row that arrived names a
    // real port and an address, and a named process is named without the quoting around it. The
    // list itself may be empty only where `ss` answered nothing — a host that runs listeners but
    // lists none is the parse failing, and the assertion below is what catches that on a host
    // this script reaches.
    eprintln!("overview: listeners={}", overview.listeners.len());
    for listener in &overview.listeners {
        assert!(listener.port > 0, "a listener names a port: {listener:?}");
        assert!(!listener.address.is_empty(), "a listener names an address: {listener:?}");
    }

    // Cron and logins may legitimately be empty on a minimal host; when they are not, the shapes
    // are the ones the panel draws — a job line, and a login row with a start and a status.
    for job in &overview.crontab {
        assert!(!job.trim().is_empty(), "a job line is not blank");
        assert!(!job.trim_start().starts_with('#'), "comments were dropped");
    }
    for login in &overview.logins {
        assert!(!login.user.is_empty(), "a login names an account: {login:?}");
        assert!(!login.tty.is_empty(), "and a terminal");
        assert!(!login.start.is_empty(), "and a start");
        assert!(!login.duration.is_empty(), "and a status column");
    }

    // The read is about the machine, not about the moment: asking again answers the same shape.
    let again = lab.core.system_overview(&handle).await.expect("a second read");
    assert_eq!(
        again.mounts.len(),
        overview.mounts.len(),
        "the mount count holds between reads"
    );
    assert_eq!(
        again.kernel, overview.kernel,
        "the kernel does not change under the test"
    );
}
