//! What a machine says about itself: services, disks, accounts, the network, the journal.
//!
//! The host monitor answers "how busy is this machine" with a sample taken every couple of seconds.
//! This is the slower, wider question behind the system panel: what is running, what is mounted,
//! who can log in, how the machine is addressed, and what the journal has said lately. It is read
//! once when the page opens rather than polled, because none of these facts changes between two
//! breaths and a page that refreshes a service list every two seconds is a page that makes a server
//! work to stay still.
//!
//! Three properties are not style, and changing any of them is a change to the security model
//! (`docs/security-model.md`, "Commands nobody typed are a constant, not a string"):
//!
//! 1. **Every command is a constant.** There is no value from a caller, a settings file or a
//!    response anywhere in the command text. The one exception is the journal's line count, and it
//!    arrives as an integer that is clamped and then formatted with `{lines}` — so what reaches the
//!    shell is still a number this file produced, not text somebody sent.
//! 2. **The commands are read-only.** No redirection that writes, nothing that starts, stops or
//!    changes a unit. The panel can be left open on a production host without the panel being the
//!    reason anything happened.
//! 3. **One round trip for the overview.** Five cheap commands over one connection cost far less
//!    than five waits, and the panel that opens with five spinning rows reads as broken before it
//!    reads as thorough. The markers that split the output are the parse, exactly as in
//!    [`crate::monitor`].
//!
//! A section that could not be read is an empty list rather than a failed overview: a container
//! without systemd has no services, and that is a fact about the container, not a reason to show
//! nothing else the host can say.

use serde_json::Value;
use sevenshell_error::ShellError;
use sevenshell_types::{
    AccountEntry, DiskDevice, InterfaceAddress, InterfaceEntry, JournalLine, JournalTail, PolicyAction, Protocol,
    RouteEntry, ServiceEntry, SystemOverview,
};

use crate::Core;
use crate::monitor::{SAMPLE_TIMEOUT, first, groups, os_release_value};

/// The service list: every unit, running or not.
///
/// `--all` is deliberate — "sshd is stopped" is exactly the fact a system panel exists to show, and
/// a list of only active units hides it. `--no-legend` drops the header and the "N loaded units
/// listed" footer so the parser does not have to know either wording, and `--plain` keeps the
/// bullet and tree glyphs out of a table that is about to be read as columns.
pub(crate) const SERVICE_COMMAND: &str = "systemctl list-units --type=service --all --no-pager --no-legend --plain";

/// The block devices, as JSON.
///
/// `-J` rather than the column output because a model name contains spaces and a recursive
/// partition tree is not something a column parser should be re-inventing; the host already knows
/// the shape and will say it.
pub(crate) const DISK_COMMAND: &str = "lsblk -J -o NAME,SIZE,TYPE,MOUNTPOINT,FSTYPE,MODEL";

/// The account table.
///
/// `getent` rather than `cat /etc/passwd` because a host may keep accounts in LDAP or SSSD, and a
/// panel that lists only the local file would be answering a different question from the one it
/// shows.
pub(crate) const ACCOUNT_COMMAND: &str = "getent passwd";

/// Who is logged in right now — the other half of [`ACCOUNT_COMMAND`]'s table.
pub(crate) const WHO_COMMAND: &str = "who";

/// The interfaces, as JSON: names, states, hardware addresses and the two byte counters.
pub(crate) const INTERFACE_COMMAND: &str = "ip -j addr show";

/// The route table, as JSON: the default gateway and everything beside it.
pub(crate) const ROUTE_COMMAND: &str = "ip -j route show";

/// The resolver's own file: the nameservers are what "can this machine resolve a name" asks.
pub(crate) const RESOLVER_COMMAND: &str = "cat /etc/resolv.conf";

/// The distribution, as the file announces itself.
pub(crate) const OS_RELEASE_COMMAND: &str = "cat /etc/os-release";

/// The kernel release, which `uname -r` answers without the rest of the `uname` line.
pub(crate) const KERNEL_COMMAND: &str = "uname -r";

/// Seconds since boot, from the kernel's own counter.
pub(crate) const UPTIME_COMMAND: &str = "cat /proc/uptime";

/// The host's timezone as it reports it.
pub(crate) const TIMEZONE_COMMAND: &str = "timedatectl show -p Timezone --value";

/// The journal's tail, with the count left for [`journal_command`] to format as a number.
///
/// `short-iso` because the timestamp has to be one a person recognises and one this side can tell
/// apart from a message without guessing at widths; `--no-pager` because there is no terminal on
/// the other end to page into.
pub(crate) const JOURNAL_COMMAND: &str = "journalctl --no-pager -o short-iso";

/// The least and most journal lines one read may ask for.
///
/// The floor is what makes a tail worth the round trip; the ceiling is what keeps a panel from
/// pulling a megabyte of journal through somebody's uplink because a caller asked for a million.
const JOURNAL_LINES_MIN: usize = 20;
const JOURNAL_LINES_MAX: usize = 500;

/// What one overview read runs: every section behind a marker line.
///
/// Assembled from the constants rather than written out again so the panel and the journal read ask
/// the host the same questions. `2>/dev/null` on each command is the same decision the monitor
/// makes: a host that does not know one of these tools is a normal host, and its complaint belongs
/// on stderr rather than in the middle of a section the parser is reading.
fn overview_command() -> String {
    format!(
        "\
echo '@@services'
{SERVICE_COMMAND} 2>/dev/null
echo '@@disks'
{DISK_COMMAND} 2>/dev/null
echo '@@accounts'
{ACCOUNT_COMMAND} 2>/dev/null
echo '@@who'
{WHO_COMMAND} 2>/dev/null
echo '@@interfaces'
{INTERFACE_COMMAND} 2>/dev/null
echo '@@routes'
{ROUTE_COMMAND} 2>/dev/null
echo '@@resolver'
{RESOLVER_COMMAND} 2>/dev/null
echo '@@os'
{OS_RELEASE_COMMAND} 2>/dev/null
echo '@@kernel'
{KERNEL_COMMAND} 2>/dev/null
echo '@@uptime'
{UPTIME_COMMAND} 2>/dev/null
echo '@@timezone'
{TIMEZONE_COMMAND} 2>/dev/null
"
    )
}

/// The journal read, with the count as a number this file produced.
///
/// The count is clamped first and formatted second, so even a value that reached here from outside
/// is digits by the time a shell sees it. That is the same rule the process detail's pid lives by:
/// nothing a person typed is ever assembled into a command.
fn journal_command(lines: usize) -> String {
    format!("{JOURNAL_COMMAND} -n {lines} 2>/dev/null")
}

/// The journal window a caller asked for, brought inside what one read may fetch.
fn clamp_journal_lines(asked: usize) -> usize {
    asked.clamp(JOURNAL_LINES_MIN, JOURNAL_LINES_MAX)
}

impl Core {
    /// Everything the system panel's first page shows, in one read.
    ///
    /// A section the host could not answer stays empty rather than failing the whole overview,
    /// because the sections are independent questions: a host with no `ip` still has disks and
    /// accounts, and the page draws an empty table where a fact is missing.
    pub async fn system_overview(&self, handle: &str) -> Result<SystemOverview, ShellError> {
        let session = self.registry.session_of(handle).await?;
        let outcome = session.exec(&overview_command(), SAMPLE_TIMEOUT).await?;

        Ok(parse_overview(&outcome.stdout))
    }

    /// The journal's tail, cut to what was asked for.
    ///
    /// Its own command rather than part of the overview because the page that shows it is opened on
    /// purpose and the page that does not should not pay for two hundred lines it will not draw.
    pub async fn journal_tail(&self, handle: &str, lines: usize) -> Result<JournalTail, ShellError> {
        let lines = clamp_journal_lines(lines);
        let session = self.registry.session_of(handle).await?;
        let outcome = session.exec(&journal_command(lines), SAMPLE_TIMEOUT).await?;

        Ok(parse_journal(&outcome.stdout))
    }

    /// Starts, restarts or stops one service, after the policy verdict for it.
    ///
    /// The unit name is the only value a person can put into this command, so it is the one thing
    /// judged before anything runs: a name is accepted only when it is shaped exactly like a
    /// systemd unit — letters, digits, and the `@ . : _ -` a real unit uses — which leaves no room
    /// for a shell metacharacter to hide in. The verb comes from a closed set; asking for one this
    /// build has no command for is refused before the session is even read.
    ///
    /// The order is the container gate's: verb, protocol, policy decision (so a `Deny` is answered
    /// before any socket), then the connection.
    pub async fn service_action(
        &self,
        session_id: &str,
        handle: &str,
        unit: &str,
        verb: &str,
        acknowledged: bool,
    ) -> Result<(), ShellError> {
        let verb = verb.trim().to_ascii_lowercase();
        let allowed = ["start", "stop", "restart", "reload", "enable", "disable"];
        if !allowed.contains(&verb.as_str()) {
            return Err(ShellError::app_unsupported("that service action does not exist"));
        }
        if !is_unit_name(unit) {
            return Err(ShellError::app_unsupported("that is not a unit name"));
        }

        let session = self.session(session_id)?;
        if !matches!(session.protocol, Protocol::Ssh | Protocol::LinuxDesk) {
            return Err(ShellError::app_unsupported("service actions belong to an SSH session"));
        }

        let verdict = sevenshell_policy::service_action(&verb);
        let saved = self.session_policy_target(session_id);
        let target = saved.as_ref().map(|saved| saved.as_target()).unwrap_or_default();
        let decision = self.policy_decision(
            &format!("service.{verb}"),
            &verdict,
            target,
            Some(session_id),
            Some(unit),
        );
        match decision.action {
            PolicyAction::Deny => return Err(ShellError::policy_denied(&format!("service.{verb}"))),
            PolicyAction::Ask if !acknowledged => {
                let rule = verdict
                    .reasons
                    .first()
                    .map(|reason| reason.rule_id.as_str())
                    .unwrap_or("service.unknown");
                return Err(ShellError::policy_approval_required(rule));
            }
            _ => {}
        }

        let remote = self.registry.session_of(handle).await?;
        // `--no-pager` keeps the answer to one line; the verb and the unit are both from closed
        // sets by the time they reach here, so nothing typed becomes syntax.
        let command = format!("systemctl {verb} --no-pager {unit}");
        let outcome = remote.exec(&command, SERVICE_TIMEOUT).await?;
        match outcome.exit_code {
            Some(0) => Ok(()),
            _ => {
                let detail = if outcome.stderr.trim().is_empty() {
                    format!("exit code {:?}", outcome.exit_code)
                } else {
                    outcome.stderr.trim().to_owned()
                };
                Err(ShellError::service_action_failed(detail))
            }
        }
    }
}

/// Whether a string is shaped like a systemd unit name and nothing else.
///
/// The whitelist is the point: every character a shell treats specially is absent from it, so a
/// name that passes cannot change what the command means — it can only name a unit.
pub(crate) fn is_unit_name(unit: &str) -> bool {
    if unit.is_empty() || unit.chars().count() > UNIT_NAME_MAX {
        return false;
    }
    unit.chars()
        .all(|character| character.is_ascii_alphanumeric() || matches!(character, '@' | '.' | ':' | '_' | '-'))
}

/// The longest unit name systemd itself allows, which is what this accepts.
const UNIT_NAME_MAX: usize = 256;

/// How long a service verb gets. Restarting a database can take a while; the command is expected
/// to come back, and one that does not is the failure this bounds.
const SERVICE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// The overview an answer describes, section by section.
///
/// Pure, and split out from the call above so each parser can be tested against text a real host
/// produced rather than against a lab full of distributions.
pub(crate) fn parse_overview(stdout: &str) -> SystemOverview {
    let mut overview = parse_overview_sections(stdout);

    let groups = groups(stdout);
    let section = |name: &str| groups.get(name).map(|lines| lines.join("\n")).unwrap_or_default();

    overview.services = parse_services(&section("services"));
    overview.disks = parse_lsblk(&section("disks"));
    overview.accounts = parse_accounts(&section("accounts"), &section("who"));
    overview.interfaces = parse_interfaces(&section("interfaces"));
    overview.routes = parse_routes(&section("routes"));
    overview.dns = parse_resolv(&section("resolver"));
    overview
}

/// The four scalars of the overview, from the four markers that carry them.
///
/// The list-shaped fields are left empty here on purpose: this is the half of the parse that
/// describes the machine rather than what is on it, and [`parse_overview`] fills the rest from the
/// same text.
pub(crate) fn parse_overview_sections(stdout: &str) -> SystemOverview {
    let groups = groups(stdout);

    let distribution = groups
        .get("os")
        .and_then(|lines| os_release_value(lines, "PRETTY_NAME"));
    let kernel = first(&groups, "kernel")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);
    let uptime_seconds = first(&groups, "uptime").and_then(uptime_seconds).unwrap_or(0);
    let timezone = first(&groups, "timezone")
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned);

    SystemOverview {
        services: Vec::new(),
        disks: Vec::new(),
        accounts: Vec::new(),
        interfaces: Vec::new(),
        routes: Vec::new(),
        dns: Vec::new(),
        distribution,
        kernel,
        uptime_seconds,
        timezone,
    }
}

/// The seconds `/proc/uptime` puts first, truncated to whole seconds.
///
/// The file reports hundredths; the panel shows days and hours, so the fraction is dropped rather
/// than rounded up — a machine that has been up for 59.9 seconds has not been up for a minute.
fn uptime_seconds(line: &str) -> Option<u64> {
    let seconds: f64 = line.split_whitespace().next()?.parse().ok()?;
    (seconds.is_finite() && seconds >= 0.0).then_some(seconds as u64)
}

/// The services `systemctl list-units` listed.
///
/// The columns are name, load, active, sub and description; the description is the rest of the line
/// and may contain any number of spaces, so only the first four fields are split off. A unit name
/// never contains a space, which is why this direction is the safe one.
///
/// The `●` bullet is stripped when it is there even though `--plain` asks for neither the bullet
/// nor the tree: this parser is also what a person's own `systemctl` output pasted into a bug
/// report would look like, and a name of `●` would be a column-wide lie.
pub(crate) fn parse_services(text: &str) -> Vec<ServiceEntry> {
    let mut out = Vec::new();

    for line in text.lines() {
        let line = line.trim();
        let line = match line.strip_prefix('●') {
            Some(rest) => rest.trim_start(),
            None => line,
        };
        if line.is_empty() {
            continue;
        }

        let mut fields = line.split_whitespace();
        let Some(name) = fields.next() else {
            continue;
        };
        // The footer `--no-legend` already suppresses, and a header from a systemctl that ignored
        // it: both begin with something that is not a unit name.
        if name.parse::<u64>().is_ok() || name == "UNIT" {
            continue;
        }

        let (Some(load), Some(active), Some(sub)) = (fields.next(), fields.next(), fields.next()) else {
            continue;
        };

        out.push(ServiceEntry {
            name: name.to_owned(),
            load: load.to_owned(),
            active: active.to_owned(),
            sub: sub.to_owned(),
            description: fields.collect::<Vec<_>>().join(" "),
        });
    }

    out
}

/// The block devices `lsblk -J` described, partitions under their disks.
///
/// The tree is the host's: a partition is a child of the disk it lives on, and a holder (LUKS, LVM)
/// is a child of the partition it opened. Nothing is re-parented here, because the nesting is the
/// only place that relationship is written down.
pub(crate) fn parse_lsblk(text: &str) -> Vec<DiskDevice> {
    let Ok(value) = serde_json::from_str::<Value>(text.trim()) else {
        return Vec::new();
    };
    value
        .get("blockdevices")
        .and_then(Value::as_array)
        .map(|devices| devices.iter().filter_map(disk_device).collect())
        .unwrap_or_default()
}

fn disk_device(value: &Value) -> Option<DiskDevice> {
    let name = text_field(value, "name")?;

    Some(DiskDevice {
        name,
        size: text_field(value, "size").unwrap_or_default(),
        kind: text_field(value, "type").unwrap_or_default(),
        mount: text_field(value, "mountpoint"),
        model: text_field(value, "model"),
        filesystem: text_field(value, "fstype"),
        children: value
            .get("children")
            .and_then(Value::as_array)
            .map(|children| children.iter().filter_map(disk_device).collect())
            .unwrap_or_default(),
    })
}

/// The account table from `/etc/passwd`'s format, with `who` saying which ones are in use.
///
/// accounts whose shell is `nologin`, `false` or empty are kept rather than filtered: `sshd` and
/// `www-data` are accounts a person looking at a machine wants to see, and hiding them would make
/// the table look like the machine has fewer accounts than it does. The panel marks them; this
/// side does not decide what a reader considers interesting.
///
/// A line whose uid will not parse is not an account: the format has no such line, so it is a
/// corrupted entry or somebody else's output, and inventing a uid for it would put a row in the
/// table that the host never claimed.
pub(crate) fn parse_accounts(passwd: &str, who: &str) -> Vec<AccountEntry> {
    let logged_in = logged_users(who);

    passwd
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split(':').collect();
            if fields.len() < 7 {
                return None;
            }

            let user = fields[0].trim();
            if user.is_empty() {
                return None;
            }
            let uid: u32 = fields[2].trim().parse().ok()?;
            let gid: u32 = fields[3].trim().parse().ok()?;

            Some(AccountEntry {
                user: user.to_owned(),
                uid,
                gid,
                shell: fields[6].trim().to_owned(),
                home: fields[5].trim().to_owned(),
                logged_in: logged_in.contains(&user),
                is_root: uid == 0,
            })
        })
        .collect()
}

/// The names `who` lists, one per login.
///
/// The first column is the account. Lines that begin with whitespace are the pseudo-entries for
/// boots and runlevel changes (`system boot`), whose first word is a description rather than a
/// person — and a machine with an account called `system` would otherwise look logged in.
fn logged_users(who: &str) -> Vec<&str> {
    who.lines()
        .filter(|line| !line.starts_with(char::is_whitespace))
        .filter_map(|line| line.split_whitespace().next())
        .collect()
}

/// The interfaces `ip -j addr show` described.
///
/// `operstate` rather than `flags` for the state: the flags say what the interface is configured
/// to do, and the operational state says what it is doing, which is what a person watching a link
/// go down is looking for. `UNKNOWN` is a real answer (a loopback reports it), and an absent
/// `address` is a loopback's honest answer — there is no hardware address to report.
pub(crate) fn parse_interfaces(text: &str) -> Vec<InterfaceEntry> {
    let Ok(value) = serde_json::from_str::<Value>(text.trim()) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|interfaces| interfaces.iter().filter_map(interface).collect())
        .unwrap_or_default()
}

fn interface(value: &Value) -> Option<InterfaceEntry> {
    let name = text_field(value, "ifname")?;
    let (rx_bytes, tx_bytes) = interface_counters(value);

    Some(InterfaceEntry {
        name,
        state: text_field(value, "operstate").unwrap_or_default(),
        mac: text_field(value, "address"),
        addresses: value
            .get("addr_info")
            .and_then(Value::as_array)
            .map(|addresses| addresses.iter().filter_map(interface_address).collect())
            .unwrap_or_default(),
        rx_bytes,
        tx_bytes,
    })
}

/// One `addr_info` entry: the family, the address, the prefix that gives it a network, and how the
/// host says it got there.
///
/// An entry without a `local` address is not an address this panel can show; `ip` emits those for
/// a tentative or failed address, and drawing one would put a blank row under the interface.
fn interface_address(info: &Value) -> Option<InterfaceAddress> {
    let family = text_field(info, "family")?;
    let address = text_field(info, "local")?;
    let prefix = info
        .get("prefixlen")
        .and_then(Value::as_u64)
        .and_then(|prefix| u8::try_from(prefix).ok())?;

    Some(InterfaceAddress {
        family,
        address,
        prefix,
        scope: text_field(info, "scope"),
    })
}

/// The two byte counters as `ip` reports them, under `stats64`.
///
/// A host that cannot report them is a host whose counters are zero here, which is the same answer
/// an interface that has never carried a byte gives — the contract has no way to say "unknown" for
/// these, and the page draws zeros rather than dashes for them.
fn interface_counters(value: &Value) -> (u64, u64) {
    let stats = value.get("stats64").or_else(|| value.get("stats"));
    let counter = |direction: &str| {
        stats
            .and_then(|stats| stats.get(direction))
            .and_then(|stats| stats.get("bytes"))
            .and_then(Value::as_u64)
            .unwrap_or_default()
    };

    (counter("rx"), counter("tx"))
}

/// The routes `ip -j route show` described.
///
/// The default route is the one destination the panel is usually asking about, and it is kept under
/// the name the tool gives it (`default`) rather than translated to `0.0.0.0/0`: a person reading
/// the row recognises the first, and the second would make the parser choose a family on the host's
/// behalf. A route with no `dev` — a blackhole or a reject route — keeps an empty device rather than
/// disappearing, because "traffic to this network goes nowhere on purpose" is a fact the page can
/// show.
pub(crate) fn parse_routes(text: &str) -> Vec<RouteEntry> {
    let Ok(value) = serde_json::from_str::<Value>(text.trim()) else {
        return Vec::new();
    };
    value
        .as_array()
        .map(|routes| routes.iter().filter_map(route).collect())
        .unwrap_or_default()
}

fn route(value: &Value) -> Option<RouteEntry> {
    Some(RouteEntry {
        destination: text_field(value, "dst")?,
        gateway: text_field(value, "gateway"),
        device: text_field(value, "dev").unwrap_or_default(),
        metric: value
            .get("metric")
            .and_then(Value::as_u64)
            .and_then(|metric| u32::try_from(metric).ok()),
    })
}

/// The nameservers `/etc/resolv.conf` names.
///
/// Comments are stripped by field rather than by line, because the file's own grammar puts a
/// comment after the value on the same line often enough. A `nameserver` with nothing after it is
/// not an address and is dropped; the resolver would ignore it too.
pub(crate) fn parse_resolv(text: &str) -> Vec<String> {
    text.lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            (fields.next()? == "nameserver").then_some(())?;
            let address = fields.next()?;
            (!address.starts_with(['#', ';'])).then(|| address.to_owned())
        })
        .collect()
}

/// The journal's tail, line by line.
///
/// A line that begins with a timestamp is an entry; a line that does not is the continuation of the
/// entry above it, which is how the journal prints a message that contains a newline. A
/// continuation with no entry above it belongs to something this read started in the middle of and
/// is skipped rather than promoted into an entry with an invented time.
///
/// `-- Logs begin at …` and `-- No entries --` are the tool talking about the journal rather than
/// the journal itself, and neither is a line. The second one is still an answer: a host with an
/// empty journal has a readable journal.
pub(crate) fn parse_journal(text: &str) -> JournalTail {
    let mut lines: Vec<JournalLine> = Vec::new();

    for raw in text.lines() {
        let raw = raw.trim_end();
        if raw.trim().is_empty() || raw.starts_with("-- ") {
            continue;
        }

        match journal_line(raw) {
            Some(line) => lines.push(line),
            None => {
                if let Some(last) = lines.last_mut() {
                    last.message.push('\n');
                    last.message.push_str(raw.trim());
                }
            }
        }
    }

    JournalTail {
        lines,
        // Empty output is a command that failed, was refused, or is not installed; the tool's own
        // `-- No entries --` is non-empty output and is a readable, empty journal.
        available: !text.trim().is_empty(),
    }
}

/// One journal entry, in the shape `-o short-iso` prints:
///
/// ```text
/// 2026-11-18T03:16:46+0800 web-1 sshd[1787]: Accepted publickey for alice from 192.168.1.5
/// ```
///
/// The timestamp is kept verbatim rather than parsed into a date, because the host's clock is what
/// this page is about and a timestamp this side reformatted would be this side's timezone.
fn journal_line(raw: &str) -> Option<JournalLine> {
    let raw = raw.trim_start();
    let at_end = raw.find(char::is_whitespace)?;
    let at = &raw[..at_end];
    if !looks_like_journal_time(at) {
        return None;
    }

    let rest = raw[at_end..].trim_start();
    let host_end = rest.find(char::is_whitespace)?;
    let rest = rest[host_end..].trim_start();

    // The identifier is everything before the first `: `; the message may contain more of them.
    // An identifier is one word (`sshd[1787]`, `kernel`), while a record the journal kept without
    // one puts its message where the identifier would be — and a message with a colon in it must
    // not be cut in half and read as a unit called "Accepted publickey for alice".
    let (unit, message) = match rest.split_once(": ").map(|(unit, message)| (unit.trim(), message)) {
        Some((unit, message)) if !unit.is_empty() && !unit.contains(char::is_whitespace) => {
            (unit.to_owned(), message.to_owned())
        }
        _ => (String::new(), rest.trim().to_owned()),
    };

    Some(JournalLine {
        at: at.to_owned(),
        unit,
        message,
    })
}

/// Whether a first word is a `short-iso` timestamp: `2026-11-18T03:16:46+0800`, and the
/// microsecond-precision variant of it.
///
/// Checked by shape rather than by parsing, because a continuation line is ordinary prose and a
/// date parser would be a heavier way to answer the same question.
fn looks_like_journal_time(token: &str) -> bool {
    let bytes = token.as_bytes();
    bytes.len() >= 19
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[10] == b'T'
        && bytes[13] == b':'
}

/// One string field of a JSON object, trimmed, with empty and null both read as absent.
fn text_field(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real `systemctl list-units --type=service --all --no-pager --no-legend --plain` answer,
    /// with a failed unit, a unit name that contains an escape, and descriptions with spaces.
    const SERVICES: &str = "\
  accounts-daemon.service        loaded active running Accounts Service
  apparmor.service               loaded active exited  Load AppArmor profiles
● auditd.service                 loaded failed failed  Security Auditing Service
  systemd-fsck@dev-disk-by\\x2duuid-6a1e.service loaded active exited File System Check on /dev/disk/by-uuid/6a1e
  user@1000.service              loaded active running User Manager for UID 1000
";

    #[test]
    fn services_are_read_by_their_first_four_columns() {
        let services = parse_services(SERVICES);

        assert_eq!(services.len(), 5);
        assert_eq!(services[0].name, "accounts-daemon.service");
        assert_eq!(services[0].load, "loaded");
        assert_eq!(services[0].active, "active");
        assert_eq!(services[0].sub, "running");
        assert_eq!(services[0].description, "Accounts Service");

        let failed = &services[2];
        assert_eq!(failed.name, "auditd.service", "the bullet is not part of the name");
        assert_eq!((failed.active.as_str(), failed.sub.as_str()), ("failed", "failed"));

        assert_eq!(services[3].name, "systemd-fsck@dev-disk-by\\x2duuid-6a1e.service");
        assert_eq!(
            services[3].description, "File System Check on /dev/disk/by-uuid/6a1e",
            "the description keeps its spaces"
        );
    }

    /// The header and footer `--no-legend` suppresses are skipped when a systemctl that ignored it
    /// prints them anyway, and an empty answer is an empty list rather than a row of blanks.
    #[test]
    fn a_service_header_or_footer_is_not_a_service() {
        let text = "\
UNIT LOAD ACTIVE SUB DESCRIPTION
  ssh.service loaded active running OpenBSD Secure Shell server
5 loaded units listed.
";

        let services = parse_services(text);
        assert_eq!(services.len(), 1);
        assert_eq!(services[0].name, "ssh.service");

        assert!(parse_services("").is_empty());
        assert!(parse_services("\n \n").is_empty());
    }

    /// A real `lsblk -J` answer: a disk with two partitions, and a second device with no children.
    const LSBLK: &str = r#"{
   "blockdevices": [
      {"name":"sda", "size":"238.5G", "type":"disk", "mountpoint":null, "fstype":null, "model":"Samsung SSD 860",
       "children":[
          {"name":"sda1", "size":"512M", "type":"part", "mountpoint":"/boot/efi", "fstype":"vfat", "model":null},
          {"name":"sda2", "size":"238G", "type":"part", "mountpoint":"/", "fstype":"ext4", "model":null}
       ]},
      {"name":"sr0", "size":"1024M", "type":"rom", "mountpoint":null, "fstype":null, "model":"DVD-RW"}
   ]
}"#;

    #[test]
    fn disks_are_read_recursively() {
        let disks = parse_lsblk(LSBLK);

        assert_eq!(disks.len(), 2);

        let sda = &disks[0];
        assert_eq!(sda.name, "sda");
        assert_eq!(sda.size, "238.5G");
        assert_eq!(sda.kind, "disk");
        assert_eq!(sda.model.as_deref(), Some("Samsung SSD 860"));
        assert_eq!(sda.mount, None);
        assert_eq!(sda.children.len(), 2, "the partitions are the disk's children");
        assert_eq!(sda.children[0].name, "sda1");
        assert_eq!(sda.children[0].mount.as_deref(), Some("/boot/efi"));
        assert_eq!(sda.children[0].filesystem.as_deref(), Some("vfat"));
        assert_eq!(sda.children[1].mount.as_deref(), Some("/"));
        assert_eq!(sda.children[1].model, None, "a partition reports no model");
        assert!(sda.children[1].children.is_empty());

        assert_eq!(disks[1].name, "sr0");
        assert_eq!(disks[1].model.as_deref(), Some("DVD-RW"));
    }

    /// A host without `lsblk`, or one whose output was cut off, is a host with no disk list rather
    /// than a failed overview.
    #[test]
    fn unreadable_disk_json_is_an_empty_list() {
        assert!(parse_lsblk("").is_empty());
        assert!(parse_lsblk("lsblk: not found").is_empty());
        assert!(parse_lsblk("{\"blockdevices\": []}").is_empty());
    }

    const PASSWD: &str = "\
root:x:0:0:root:/root:/bin/bash
daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin
alice:x:1000:1000:Alice,,,:/home/alice:/bin/bash
broken:x:notanumber:1001:Broken:/home/broken:/bin/sh
";

    const WHO: &str = "\
alice    pts/0        2026-11-18 10:12 (192.168.1.5)
         system boot  2026-11-18 09:00
root     pts/1        2026-11-18 10:13 (10.0.0.2)
";

    #[test]
    fn accounts_keep_the_ones_that_cannot_log_in_and_mark_the_ones_that_are() {
        let accounts = parse_accounts(PASSWD, WHO);

        assert_eq!(accounts.len(), 3, "the unparseable uid is not an account");

        let root = &accounts[0];
        assert_eq!(root.user, "root");
        assert_eq!((root.uid, root.gid), (0, 0));
        assert!(root.is_root);
        assert!(root.logged_in);

        let daemon = &accounts[1];
        assert_eq!(
            daemon.shell, "/usr/sbin/nologin",
            "the account is kept; whether it can log in is the panel's mark to draw"
        );
        assert!(!daemon.is_root);
        assert!(!daemon.logged_in);

        let alice = &accounts[2];
        assert_eq!((alice.uid, alice.gid), (1000, 1000));
        assert_eq!(alice.home, "/home/alice");
        assert!(alice.logged_in);
        assert!(!alice.is_root);
    }

    /// A `who` with only the boot pseudo-entry leaves nobody logged in, and an account with no
    /// password line at all is simply not in the answer.
    #[test]
    fn a_host_with_nobody_logged_in_marks_nobody_in() {
        let accounts = parse_accounts(PASSWD, "         system boot  2026-11-18 09:00\n");

        assert!(accounts.iter().all(|account| !account.logged_in));
    }

    /// A real `ip -j addr show`: a loopback with no hardware address, and an interface with both
    /// address families and the byte counters.
    const INTERFACES: &str = r#"[
 {"ifindex":1,"ifname":"lo","flags":["LOOPBACK","UP","LOWER_UP"],"mtu":65536,"operstate":"UNKNOWN",
  "addr_info":[{"family":"inet","local":"127.0.0.1","prefixlen":8,"scope":"host"},
               {"family":"inet6","local":"::1","prefixlen":128,"scope":"host"}],
  "stats64":{"rx":{"bytes":123456,"packets":100},"tx":{"bytes":123456,"packets":100}}},
 {"ifindex":2,"ifname":"eth0","flags":["BROADCAST","MULTICAST","UP","LOWER_UP"],"mtu":1500,
  "operstate":"UP","address":"52:54:00:12:34:56",
  "addr_info":[{"family":"inet","local":"192.168.1.20","prefixlen":24,"scope":"global"},
               {"family":"inet6","local":"fe80::5054:ff:fe12:3456","prefixlen":64,"scope":"link"}],
  "stats64":{"rx":{"bytes":12345678,"packets":9000},"tx":{"bytes":2345678,"packets":8000}}}
]"#;

    #[test]
    fn interfaces_carry_both_families_and_their_counters() {
        let interfaces = parse_interfaces(INTERFACES);

        assert_eq!(interfaces.len(), 2);

        let loopback = &interfaces[0];
        assert_eq!(loopback.name, "lo");
        assert_eq!(loopback.state, "UNKNOWN", "which is what a loopback reports");
        assert_eq!(loopback.mac, None, "a loopback has no hardware address");
        assert_eq!(loopback.addresses.len(), 2);
        assert_eq!(loopback.addresses[0].family, "inet");
        assert_eq!(loopback.addresses[0].address, "127.0.0.1");
        assert_eq!(loopback.addresses[0].prefix, 8);
        assert_eq!(loopback.addresses[0].scope.as_deref(), Some("host"));

        let ethernet = &interfaces[1];
        assert_eq!(ethernet.name, "eth0");
        assert_eq!(ethernet.state, "UP");
        assert_eq!(ethernet.mac.as_deref(), Some("52:54:00:12:34:56"));
        assert_eq!(ethernet.addresses[1].family, "inet6");
        assert_eq!(ethernet.addresses[1].prefix, 64);
        assert_eq!(ethernet.rx_bytes, 12_345_678);
        assert_eq!(ethernet.tx_bytes, 2_345_678);
    }

    #[test]
    fn unreadable_interface_json_is_an_empty_list() {
        assert!(parse_interfaces("").is_empty());
        assert!(parse_interfaces("ip: command not found").is_empty());
        assert!(parse_interfaces("[]").is_empty());
    }

    /// A real `ip -j route show`, default route first.
    const ROUTES: &str = r#"[
 {"dst":"default","gateway":"192.168.1.1","dev":"eth0","protocol":"dhcp","metric":100},
 {"dst":"192.168.1.0/24","dev":"eth0","protocol":"kernel","scope":"link","prefsrc":"192.168.1.20","metric":100},
 {"dst":"10.8.0.0/24","gateway":"10.8.0.1","dev":"tun0","protocol":"static"}
]"#;

    #[test]
    fn routes_keep_the_default_one() {
        let routes = parse_routes(ROUTES);

        assert_eq!(routes.len(), 3);

        let default = &routes[0];
        assert_eq!(default.destination, "default");
        assert_eq!(default.gateway.as_deref(), Some("192.168.1.1"));
        assert_eq!(default.device, "eth0");
        assert_eq!(default.metric, Some(100));

        assert_eq!(routes[1].destination, "192.168.1.0/24");
        assert_eq!(routes[1].gateway, None, "a link route has no gateway");

        assert_eq!(routes[2].device, "tun0");
        assert_eq!(routes[2].metric, None, "no metric is not metric zero");
    }

    #[test]
    fn resolver_comments_are_not_nameservers() {
        let text = "\
# Generated by NetworkManager
nameserver 192.168.1.1
nameserver 8.8.8.8 # cloudflare
; a comment
nameserver 2001:4860:4860::8888
search lan
";

        assert_eq!(parse_resolv(text), ["192.168.1.1", "8.8.8.8", "2001:4860:4860::8888"]);
        assert!(parse_resolv("").is_empty());
    }

    /// A journal tail with the tool's own header, an ordinary entry, a message that ran over two
    /// lines, and a kernel line.
    const JOURNAL: &str = "\
-- Logs begin at Mon 2026-11-17 21:00:00 CST, end at Tue 2026-11-18 03:20:00 CST. --
2026-11-18T03:16:46+0800 web-1 systemd[1]: Starting Daily apt upgrade...
2026-11-18T03:16:47+0800 web-1 sshd[1787]: Accepted publickey for alice from 192.168.1.5 port 52344 ssh2
The fingerprint is SHA256:abcdef.
2026-11-18T03:16:48+0800 web-1 kernel: [UFW BLOCK] IN=eth0 OUT= SRC=1.2.3.4
";

    #[test]
    fn the_journal_tail_is_read_line_by_line() {
        let tail = parse_journal(JOURNAL);

        assert!(tail.available);
        assert_eq!(tail.lines.len(), 3, "the header and the continuation are not entries");

        assert_eq!(tail.lines[0].at, "2026-11-18T03:16:46+0800");
        assert_eq!(tail.lines[0].unit, "systemd[1]");
        assert_eq!(tail.lines[0].message, "Starting Daily apt upgrade...");

        assert_eq!(tail.lines[1].unit, "sshd[1787]");
        assert_eq!(
            tail.lines[1].message,
            "Accepted publickey for alice from 192.168.1.5 port 52344 ssh2\nThe fingerprint is SHA256:abcdef.",
            "a line without a timestamp continues the entry above it"
        );

        assert_eq!(tail.lines[2].unit, "kernel");
        assert_eq!(tail.lines[2].message, "[UFW BLOCK] IN=eth0 OUT= SRC=1.2.3.4");
    }

    /// A record the journal kept without an identifier prints its message where the identifier
    /// would be. The first `: ` is then part of the message, not the end of a unit name.
    #[test]
    fn a_journal_line_without_an_identifier_keeps_its_message_whole() {
        let tail = parse_journal("2026-11-18T03:16:49+0800 web-1 connection from 10.0.0.9 closed: reset by peer\n");

        assert_eq!(tail.lines.len(), 1);
        assert_eq!(tail.lines[0].unit, "");
        assert_eq!(tail.lines[0].message, "connection from 10.0.0.9 closed: reset by peer");
    }

    #[test]
    fn an_unreadable_or_empty_journal_is_not_available() {
        let empty = parse_journal("");
        assert!(!empty.available, "empty output is a command that did not answer");
        assert!(empty.lines.is_empty());

        let no_entries = parse_journal("-- No entries --\n");
        assert!(
            no_entries.available,
            "the tool answered, and the answer is that the journal is empty"
        );
        assert!(no_entries.lines.is_empty());

        let fragment = parse_journal("orphan continuation with no entry above it\n");
        assert!(fragment.available);
        assert!(
            fragment.lines.is_empty(),
            "a fragment is not promoted into an entry with an invented timestamp"
        );
    }

    /// The four scalars, from the four markers the overview command introduces.
    #[test]
    fn the_overview_scalars_are_read_by_their_markers() {
        let text = "\
@@os
NAME=\"Ubuntu\"
PRETTY_NAME=\"Ubuntu 24.04.1 LTS\"
@@kernel
6.8.0-45-generic
@@uptime
98765.43 123456.78
@@timezone
Asia/Shanghai
";

        let overview = parse_overview_sections(text);

        assert_eq!(overview.distribution.as_deref(), Some("Ubuntu 24.04.1 LTS"));
        assert_eq!(overview.kernel.as_deref(), Some("6.8.0-45-generic"));
        assert_eq!(overview.uptime_seconds, 98_765, "the fraction is not a whole second");
        assert_eq!(overview.timezone.as_deref(), Some("Asia/Shanghai"));
        assert!(overview.services.is_empty(), "this half describes the machine");
    }

    /// The overview joins the sections without letting one of them take the rest with it: an
    /// unparseable disk section leaves the services and the scalars exactly as the host said them.
    #[test]
    fn one_unreadable_section_does_not_take_the_overview_with_it() {
        let text = "\
@@services
  ssh.service loaded active running OpenBSD Secure Shell server
@@disks
lsblk: not found
@@accounts
root:x:0:0:root:/root:/bin/bash
@@who
@@interfaces
not json
@@routes
@@resolver
nameserver 192.168.1.1
@@os
PRETTY_NAME=\"Debian GNU/Linux 12 (bookworm)\"
@@kernel
6.1.0-18-amd64
@@uptime
1234.56 9999.99
@@timezone
Etc/UTC
";

        let overview = parse_overview(text);

        assert_eq!(overview.services.len(), 1);
        assert_eq!(overview.services[0].name, "ssh.service");
        assert!(overview.disks.is_empty());
        assert!(overview.interfaces.is_empty());
        assert!(overview.routes.is_empty());
        assert_eq!(overview.accounts.len(), 1);
        assert!(overview.accounts[0].is_root);
        assert_eq!(overview.dns, ["192.168.1.1"]);
        assert_eq!(overview.distribution.as_deref(), Some("Debian GNU/Linux 12 (bookworm)"));
        assert_eq!(overview.kernel.as_deref(), Some("6.1.0-18-amd64"));
        assert_eq!(overview.uptime_seconds, 1_234);
        assert_eq!(overview.timezone.as_deref(), Some("Etc/UTC"));
    }

    #[test]
    fn the_journal_window_is_bounded_however_much_is_asked_for() {
        assert_eq!(clamp_journal_lines(0), JOURNAL_LINES_MIN);
        assert_eq!(clamp_journal_lines(20), 20);
        assert_eq!(clamp_journal_lines(200), 200);
        assert_eq!(clamp_journal_lines(usize::MAX), JOURNAL_LINES_MAX);
    }

    // -- unit names, which are the one thing a person puts into a service command ----------

    #[test]
    fn a_unit_name_is_accepted_when_it_is_shaped_like_one() {
        for unit in [
            "sshd.service",
            "nginx",
            "getty@tty1.service",
            "nginx.service.d",
            "db-2_x:1.service",
        ] {
            assert!(is_unit_name(unit), "{unit} is a unit name");
        }
    }

    #[test]
    fn a_name_that_could_change_the_command_is_refused() {
        // Every one of these is a way to end up running something nobody asked for.
        for unit in [
            "nginx; rm -rf /",
            "nginx && reboot",
            "$(reboot)",
            "`reboot`",
            "nginx | tee /etc/passwd",
            "../etc/passwd",
            "nginx
reboot",
            "nginx reboot",
            "",
        ] {
            assert!(!is_unit_name(unit), "{unit:?} must not reach a command");
        }
    }

    #[test]
    fn a_name_longer_than_systemd_allows_is_refused() {
        let long = "a".repeat(UNIT_NAME_MAX + 1);
        assert!(!is_unit_name(&long));
        assert!(is_unit_name(&"a".repeat(UNIT_NAME_MAX)));
    }
}
