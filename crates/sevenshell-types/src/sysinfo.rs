//! What a machine says about itself when the desktop asks in more detail than a sample.
//!
//! The host monitor answers "how busy is this machine"; these are the questions underneath it —
//! which services are running, what the disks look like, who can log in, how the network is
//! addressed, and what the journal has said lately. Every one of them is a fixed, read-only
//! command with no value anybody typed, which is the rule the monitor's four constants already
//! live by (`docs/security-model.md`, "Commands nobody typed are a constant, not a string").
//!
//! Nothing here is a secret: an account list names accounts, not their password hashes, and the
//! journal is bounded to the lines a person asked to see.

use serde::{Deserialize, Serialize};

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

/// Everything the system panel's first page shows, in one read.
///
/// One round trip rather than five: they are five cheap commands, and a panel that opens with
/// five separate waits feels broken before it feels thorough.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemOverview {
    pub services: Vec<ServiceEntry>,
    pub disks: Vec<DiskDevice>,
    pub accounts: Vec<AccountEntry>,
    pub interfaces: Vec<InterfaceEntry>,
    pub routes: Vec<RouteEntry>,
    pub dns: Vec<String>,
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
}
