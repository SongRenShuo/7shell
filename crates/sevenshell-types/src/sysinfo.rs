//! What a machine says about itself when the desktop asks in more detail than a sample.
//!
//! The host monitor answers "how busy is this machine"; these are the questions underneath it —
//! which services are running and which start at boot, what the disks look like, who can log in
//! and who has, what cron has scheduled, whether a firewall is on, how the network is addressed,
//! and what the journal has said lately. Every one of them is a fixed, read-only command with no
//! value anybody typed, which is the rule the monitor's four constants already live by
//! (`docs/security-model.md`, "Commands nobody typed are a constant, not a string").
//!
//! Nothing here is a secret: an account list names accounts, not their password hashes, and the
//! journal is bounded to the lines a person asked to see.

use serde::{Deserialize, Serialize};

use crate::monitor::DiskUsage;

/// One systemd service, as `systemctl list-units` reports it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceEntry {
    /// The unit name, `sshd.service` and the like.
    pub name: String,
    /// `loaded`, `not-found`, `masked` — what systemd says about the unit file.
    pub load: String,
    /// `active`, `inactive`, `failed`.
    pub active: String,
    /// `running`, `exited`, `dead` — the finer state, worth a column of its own.
    pub sub: String,
    /// The unit's own one-line description.
    pub description: String,
    /// What `systemctl list-unit-files` says about starting it at boot, in the host's own spelling:
    /// `enabled`, `disabled`, `static`, `masked`, `indirect`, `alias`, `generated`, …
    ///
    /// `None` when the unit has no entry in that list. The list is of unit *files*, so a transient
    /// unit — a service systemd started itself and never wrote a file for — is absent from it, and
    /// that absence is a fact rather than a state: there is nothing to enable at boot. The field is
    /// omitted from the wire when it is `None`, so a mirror must treat it as possibly missing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<String>,
}

/// One block device, with the partitions under it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskDevice {
    /// `sda`, `nvme0n1`, `vda` — the kernel's name.
    pub name: String,
    /// The size as the host spells it (`238.5G`), because converting it would lose the unit the
    /// host chose.
    pub size: String,
    /// `disk`, `part`, `loop`, `rom`.
    pub kind: String,
    /// Where it is mounted, when it is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mount: Option<String>,
    /// The model a disk reports, when it reports one. Absent on partitions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    /// The filesystem, when the host named one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filesystem: Option<String>,
    /// Partitions and holders, in the host's own order.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub children: Vec<DiskDevice>,
}

/// One account that can log in, from `/etc/passwd` and the login table.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountEntry {
    pub user: String,
    pub uid: u32,
    pub gid: u32,
    /// The login shell; `/usr/sbin/nologin` is how an account says it is not for logging in.
    pub shell: String,
    pub home: String,
    /// Whether somebody is logged in as this account right now.
    pub logged_in: bool,
    /// Whether the account is root (`uid` 0), which the panel draws apart.
    pub is_root: bool,
}

/// One address on one interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceAddress {
    /// `inet` or `inet6`.
    pub family: String,
    pub address: String,
    /// The prefix length, which is what tells an address apart from its network.
    pub prefix: u8,
    /// `dhcp`, `manual`, `none` — how it got there, when the host says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<String>,
}

/// One network interface.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InterfaceEntry {
    pub name: String,
    /// `UP`, `DOWN`, `UNKNOWN` — the operational state.
    pub state: String,
    /// The hardware address, when there is one. A loopback has none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mac: Option<String>,
    pub addresses: Vec<InterfaceAddress>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

/// One route: the default gateway most of all, which is what "can this machine reach anything"
/// is usually asking about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteEntry {
    pub destination: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    pub device: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub metric: Option<u32>,
}

/// One line of the journal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalLine {
    /// The timestamp the host wrote, verbatim — it is the host's clock that matters here.
    pub at: String,
    /// The unit or process that wrote it, when the journal names one.
    pub unit: String,
    pub message: String,
}

/// What the journal's tail came back as.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JournalTail {
    pub lines: Vec<JournalLine>,
    /// Whether the host's journal was readable at all — a container without systemd answers no,
    /// and that is a fact about the machine rather than a failure of the read.
    pub available: bool,
}

/// One row of the login table `last -n 20 -w` prints.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginRecord {
    /// The account, or `reboot` for the machine's own boot record.
    pub user: String,
    /// The terminal, or `system boot` for the boot record.
    pub tty: String,
    /// Where the login came from, as the host spells it — an address, a hostname, or the kernel
    /// release of a boot record. Empty when the host left the column blank, which is how a console
    /// login prints; an empty string is the row's own answer rather than a missing field.
    pub from: String,
    /// When the session started, in the host's own words: `Wed Nov 18 10:59`.
    pub start: String,
    /// The row's trailing status column, as the host printed it, with the column's padding
    /// collapsed and the ` - ` separator taken out: `still logged in`, `still running`,
    /// `down (00:01)`, or `11:01 (00:03)` (end and duration for a session that ended).
    ///
    /// Kept in the host's spelling rather than parsed into a number of minutes because `last`
    /// prints several things in that column — a duration, a state word, `gone - no logout` — and a
    /// normalisation this side invented would be this side's vocabulary, not the host's.
    pub duration: String,
    /// Whether the session is still up. True for `still logged in` and for a boot record's
    /// `still running`; false for every row that carries an end.
    pub still_logged_in: bool,
}

/// The host's firewall, as far as the two tools on it would say.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FirewallStatus {
    /// `ufw` or `firewalld` — whichever answered first. Empty when neither did, which is the
    /// "no firewall tool on this host" row (see `installed`).
    pub backend: String,
    /// Whether a tool answered at all. False means neither `ufw` nor `firewall-cmd` produced an
    /// answer, and the page says "not installed" rather than drawing a firewall that is off.
    ///
    /// Read precisely: the tools print on stderr when the binary is missing *and* when the account
    /// may not read their state (`ERROR: You need to be root to run this script`), and both arrive
    /// here as no answer. The page's wording is therefore "not installed" in the sense of "no tool
    /// would say", which a non-root session on a host that has ufw also produces.
    pub installed: bool,
    /// Whether the firewall is on: `Status: active` for ufw, `running` for firewalld.
    pub active: bool,
    /// The single line the tool printed — `Status: active`, `Status: inactive`, `running`,
    /// `not running` — so the page can show the host's own wording beside the state.
    pub detail: String,
}

/// One TCP port the host is listening on, with the process that holds it.
///
/// From `ss -tlnp`, which names a process only when the reading account may see it — a service
/// under another account arrives with the port and address and an empty name, which is a fact
/// about the reading account, not a lost row.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemListener {
    /// The port the host listens on.
    pub port: u16,
    /// The address the listener binds, as the host printed it with the IPv6 brackets taken off:
    /// `127.0.0.1`, `0.0.0.0`, `::`.
    pub address: String,
    /// The process behind the listener, as the host named it. Empty when the host did not name
    /// one — the port belongs to another account's process, or `ss` runs without the sight.
    pub process: String,
}

/// Everything the system panel's first page shows, in one read.
///
/// One round trip rather than a dozen: they are a dozen cheap commands, and a panel that opens
/// with a dozen separate waits feels broken before it feels thorough.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub services: Vec<ServiceEntry>,
    pub disks: Vec<DiskDevice>,
    pub accounts: Vec<AccountEntry>,
    pub interfaces: Vec<InterfaceEntry>,
    pub routes: Vec<RouteEntry>,
    pub dns: Vec<String>,
    /// The crontab's job lines, trimmed: comments and blank lines are gone, everything else is
    /// kept exactly as written, because the schedule text is the data.
    ///
    /// Always on the wire — an empty list is "this account has no jobs" and is drawn as such.
    #[serde(default)]
    pub crontab: Vec<String>,
    /// The last few logins, newest first as `last` prints them.
    ///
    /// Always on the wire; empty when the host keeps no login records.
    #[serde(default)]
    pub logins: Vec<LoginRecord>,
    /// The firewall, or `None` when the read never asked — a marker absent from the answer, which
    /// is not the same answer as "asked and no tool is installed".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub firewall: Option<FirewallStatus>,
    /// The mounted file systems with their usage, from the same `df -kP` the monitor samples.
    ///
    /// Its own read rather than borrowed from the monitor's last sample: the monitor only samples
    /// while somebody is watching it, and a panel that opens after a quiet minute would otherwise
    /// draw a ring from a number that is older than the panel. Always on the wire — every row the
    /// host listed, capped by the monitor parser's own limit; what to draw is the page's decision.
    #[serde(default)]
    pub mounts: Vec<DiskUsage>,
    /// `/etc/os-release`'s pretty name, when the host has one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub distribution: Option<String>,
    /// The kernel release.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kernel: Option<String>,
    /// Seconds since boot, which is the machine's own uptime rather than this build's guess.
    pub uptime_seconds: u64,
    /// The host's timezone as it reports it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    /// The TCP ports the host is listening on, with the process behind each.
    ///
    /// Absent from the wire when empty — the mirror reads `overview.listeners ?? []`. An empty
    /// list is the host saying "nothing I can see" (an `ss` without the answer, a host with no
    /// listeners), which is a fact and not a hole.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub listeners: Vec<SystemListener>,
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    /// An overview with one of everything, so the fields' serialized names can be read back.
    fn overview() -> SystemOverview {
        SystemOverview {
            services: vec![ServiceEntry {
                name: "sshd.service".to_owned(),
                load: "loaded".to_owned(),
                active: "active".to_owned(),
                sub: "running".to_owned(),
                description: "OpenSSH server".to_owned(),
                enabled: None,
            }],
            disks: Vec::new(),
            accounts: Vec::new(),
            interfaces: Vec::new(),
            routes: Vec::new(),
            dns: Vec::new(),
            crontab: vec!["0 3 * * * /usr/local/bin/backup.sh".to_owned()],
            logins: vec![LoginRecord {
                user: "reboot".to_owned(),
                tty: "system boot".to_owned(),
                from: "5.15.0-203-generic".to_owned(),
                start: "Wed Nov 18 03:18".to_owned(),
                duration: "still running".to_owned(),
                still_logged_in: true,
            }],
            firewall: None,
            mounts: Vec::new(),
            distribution: None,
            kernel: None,
            uptime_seconds: 0,
            timezone: None,
            listeners: Vec::new(),
        }
    }

    /// The names the interface reads, and the two places where absence is the shape: a service
    /// whose unit file the host did not list has no `enabled` key, and a read that never asked
    /// about a firewall has no `firewall` key. The mirror in `apps/desktop/src/types/sysinfo.ts`
    /// makes exactly those two optional, and a mirror that made them required would draw
    /// `undefined` the first time a real payload left them out.
    #[test]
    fn the_wire_uses_camel_case_and_omits_what_the_host_did_not_say() {
        let value = serde_json::to_value(overview()).expect("an overview is JSON");

        assert_eq!(value["services"][0]["name"], json!("sshd.service"));
        assert!(
            value["services"][0].get("enabled").is_none(),
            "a unit with no file has no boot state on the wire"
        );
        assert_eq!(value["logins"][0]["stillLoggedIn"], json!(true));
        assert_eq!(value["crontab"][0], json!("0 3 * * * /usr/local/bin/backup.sh"));
        assert!(value.get("firewall").is_none(), "a read that never asked omits the key");
        assert!(value.get("listeners").is_none(), "a host that named no listener omits the key");
        assert_eq!(
            value["mounts"],
            json!([]),
            "a list that is sent is sent even when empty"
        );
    }

    /// The listeners are the one list that is left off the wire when empty, and the one whose
    /// absence a mirror has to read as a list — hence this test sitting next to the omission one
    /// above.
    #[test]
    fn listeners_ride_the_wire_when_the_host_listed_any() {
        let mut overview = overview();
        overview.listeners = vec![SystemListener {
            port: 22,
            address: "0.0.0.0".to_owned(),
            process: "sshd".to_owned(),
        }];

        let value = serde_json::to_value(overview).expect("an overview is JSON");
        assert_eq!(value["listeners"][0]["port"], json!(22));
        assert_eq!(value["listeners"][0]["address"], json!("0.0.0.0"));
        assert_eq!(value["listeners"][0]["process"], json!("sshd"));
    }

    /// The two values that are a shape rather than a word: a firewall that answered, and a service
    /// whose boot state the host did spell out.
    #[test]
    fn the_optional_fields_are_written_when_they_have_an_answer() {
        let mut overview = overview();
        overview.services[0].enabled = Some("masked".to_owned());
        overview.firewall = Some(FirewallStatus {
            backend: "ufw".to_owned(),
            installed: true,
            active: false,
            detail: "Status: inactive".to_owned(),
        });

        let value: Value = serde_json::to_value(overview).expect("an overview is JSON");

        assert_eq!(value["services"][0]["enabled"], json!("masked"));
        assert_eq!(value["firewall"]["backend"], json!("ufw"));
        assert_eq!(value["firewall"]["installed"], json!(true));
        assert_eq!(value["firewall"]["active"], json!(false));
        assert_eq!(value["firewall"]["detail"], json!("Status: inactive"));
    }
}
