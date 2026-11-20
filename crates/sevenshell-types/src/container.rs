//! What the interface knows about containers, container images and the runtime behind them.
//!
//! Every field here is either an identifier the runtime assigned or something the CLI printed.
//! Nothing in this module carries a credential, and nothing carries a local path: an image archive
//! or a kubeconfig is chosen in a native dialog and stays on the Rust side.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::session::SecretInput;

/// Which command line speaks to the container runtime.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerRuntime {
    #[default]
    Docker,
    Podman,
    Nerdctl,
    Wslc,
}

impl ContainerRuntime {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::Nerdctl => "nerdctl",
            Self::Wslc => "wslc",
        }
    }

    /// The runtime's own command name. Kept beside `as_str` so a label can never become a program.
    pub const fn program(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
            Self::Nerdctl => "nerdctl",
            Self::Wslc => "wslc",
        }
    }

    pub const fn is_windows_only(self) -> bool {
        matches!(self, Self::Wslc)
    }
}

/// Where the runtime is reached.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ContainerTransport {
    /// A process on this machine.
    #[default]
    Local,
    /// Through a saved SSH session, which supplies the host, the credentials and any jump route.
    Ssh,
}

/// The container half of a saved session.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSettings {
    #[serde(default)]
    pub runtime: ContainerRuntime,
    #[serde(default)]
    pub transport: ContainerTransport,
    /// The saved SSH session used when `transport` is `ssh`. A reference, never a copy.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ssh_session: String,
    /// The nerdctl namespace. Empty and `default` mean the same thing.
    #[serde(default)]
    pub namespace: String,
}

impl ContainerSettings {
    /// Whether this session is not a container one, which keeps the field out of every other
    /// session's document.
    pub fn is_empty(&self) -> bool {
        *self == Self::default()
    }
}

/// One container as a list row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerSummary {
    pub id: String,
    pub name: String,
    pub image: String,
    /// The runtime's own state word (`running`, `exited`, `paused`, …), shown as printed.
    pub state: String,
    /// The human sentence the runtime prints next to the state.
    pub status: String,
    pub ports: String,
    pub created_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPort {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host_ip: String,
    pub host_port: String,
    pub container_port: String,
    pub protocol: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerMount {
    pub source: String,
    pub destination: String,
    pub read_only: bool,
}

/// One container in full, plus the runtime's own JSON for the inspection tab.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerDetail {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub started_at: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub finished_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i64>,
    #[serde(default)]
    pub oom_killed: bool,
    #[serde(default)]
    pub pid: u64,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub restart_policy: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub entrypoint: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub work_dir: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub user: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub network_mode: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ip: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gateway: String,
    #[serde(default)]
    pub ports: Vec<ContainerPort>,
    #[serde(default)]
    pub mounts: Vec<ContainerMount>,
    #[serde(default)]
    pub env: Vec<String>,
    /// The runtime's inspect output, exactly as it printed it.
    pub raw: String,
}

/// One image as a list row shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerImage {
    pub id: String,
    pub repository: String,
    pub tag: String,
    pub size: String,
    pub created_at: String,
}

/// One layer of an image's history.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageLayer {
    pub id: String,
    pub created_by: String,
    pub size: String,
    pub created_at: String,
}

/// A point-in-time sample from `stats`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStats {
    pub id: String,
    pub name: String,
    pub cpu_percent: f64,
    pub memory_usage: u64,
    pub memory_limit: u64,
    pub memory_percent: f64,
    pub network_input: u64,
    pub network_output: u64,
    pub block_input: u64,
    pub block_output: u64,
    pub pids: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStateCount {
    pub state: String,
    pub count: u32,
}

/// What the runtime says about itself and its host, for the overview page.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRuntimeInfo {
    pub runtime: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub client_component: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub server_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub server_component: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub storage_driver: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cgroup_driver: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub cgroup_version: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub os: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub arch: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub kernel: String,
    #[serde(default)]
    pub cpus: u32,
    #[serde(default)]
    pub memory: u64,
    #[serde(default)]
    pub containers_total: u32,
    #[serde(default)]
    pub containers_by_state: Vec<ContainerStateCount>,
    #[serde(default)]
    pub images_total: u32,
    #[serde(default)]
    pub images_tagged: u32,
    #[serde(default)]
    pub images_dangling: u32,
    /// Whether the engine's Compose plugin answered when the engine was opened. Absent on the
    /// connections that were never probed, and on engines where the plugin is missing — which is
    /// the interface's cue to show the overview only.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub compose_available: bool,
    /// Whether the network surface can be asked. A desktop engine is Docker by construction, so
    /// this is true wherever the Compose bit is; it is absent elsewhere so the mirror stays honest.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub network_available: bool,
    /// Whether the engine's command line can answer a request for an image's remote digest — the
    /// question behind the image page's "check for updates". Probed once when a desktop engine
    /// opened; absent on the connections that were never probed, which reads as "may have it".
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub manifest_inspect_available: bool,
}

/// What the engine's `info` says about where it pulls from.
///
/// Every field is absent when the engine has nothing to say about it: a mirror list nobody
/// configured and a proxy nobody set are the empty answer, not an error, and the interface draws
/// its empty sentences from the absence.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRegistrySettings {
    /// The pull-through mirrors the daemon consults before the upstream registry, in the order it
    /// consults them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub mirrors: Vec<String>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub http_proxy: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub https_proxy: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub no_proxy: String,
}

/// The remote digest of one image tag, beside the digests the local engine recorded for it.
///
/// `up_to_date` is answered only when both sides answered; a registry that would not speak and an
/// engine without the image locally are both honest absences, not a guess either way.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerImageRemoteDigest {
    pub reference: String,
    /// The digest the registry serves for this tag, as the engine would pull it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_digest: Option<String>,
    /// The digests the local engine recorded for this image's pulls (`RepoDigests`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub local_digests: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub up_to_date: Option<bool>,
    /// Which registry answered: a mirror host, or `upstream` when the engine's own index did.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub source: String,
}

/// One line of a stream the backend is following, tagged with the stream it belongs to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStreamLine {
    pub stream_id: String,
    pub line: String,
}

/// The last event of a stream. `error` is present when it ended because something failed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerStreamEnd {
    pub stream_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A port mapping asked for when a container is created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerPortMapping {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host_ip: String,
    pub host_port: u16,
    pub container_port: u16,
    #[serde(default)]
    pub protocol: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerVolume {
    pub source: String,
    pub destination: String,
    /// Mount the volume read-only. Absent means read-write, the way `docker run` does.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub read_only: bool,
}

/// The CPU weight presets the create dialog offers, in the reference's three steps. The engine turns each
/// into the `--cpu-shares` count the runtime takes.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ContainerCpuWeight {
    High,
    #[default]
    Normal,
    Low,
}

impl ContainerCpuWeight {
    /// The share count each step maps to, matching the reference's own three-step values.
    pub const fn cpu_shares(self) -> u32 {
        match self {
            Self::High => 768,
            Self::Normal => 512,
            Self::Low => 256,
        }
    }
}

/// Everything the create dialog collects.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCreateRequest {
    pub image: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default)]
    pub ports: Vec<ContainerPortMapping>,
    #[serde(default)]
    pub volumes: Vec<ContainerVolume>,
    #[serde(default)]
    pub env: Vec<String>,
    #[serde(default)]
    pub restart_policy: String,
    /// The command as one line; the backend splits it into argv without a shell.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub command: String,
    #[serde(default)]
    pub interactive: bool,
    #[serde(default)]
    pub tty: bool,
    /// Run the container with the host's device access. The dialog asks twice before this is set.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub privileged: bool,
    /// One Linux capability per `--cap-add`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capabilities: Vec<String>,
    /// One network per `--network`, in the order the dialog listed them.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub networks: Vec<String>,
    /// The memory ceiling in MiB; the engine converts it to bytes for `--memory`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_limit_mb: Option<u64>,
    /// The CPU weight preset, or none for the runtime's default.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cpu_weight: Option<ContainerCpuWeight>,
    /// The labels a person wrote as remarks. A map, so the same key cannot be written twice.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<BTreeMap<String, String>>,
}

/// A pull or a push.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerImageTransfer {
    pub image: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub platform: String,
    #[serde(default)]
    pub all_tags: bool,
    #[serde(default)]
    pub insecure: bool,
}

/// A registry login. The password is the one secret that travels in this module, and only in.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerRegistryLogin {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub registry: String,
    pub username: String,
    pub secret: SecretInput,
    #[serde(default)]
    pub insecure: bool,
}

/// A commit of a container's filesystem into an image.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainerCommitRequest {
    pub container_id: String,
    pub image: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub message: String,
}

/// One Docker network as a list row shows it.
///
/// The address fields (`subnet`, `gateway`, `ipRange`) are filled in from the network's inspect,
/// which is why they may be absent: the built-in networks answer them, but a network whose driver
/// has no IPAM at all does not.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkSummary {
    pub name: String,
    pub driver: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub scope: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subnet: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gateway: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ip_range: String,
    #[serde(default)]
    pub ipv6: bool,
    #[serde(default)]
    pub internal: bool,
    /// How many containers are attached right now. The removal guardrail reads this before a
    /// network is allowed to leave.
    pub containers: u32,
}

/// Everything the network create form collects.
///
/// Every address field is a CIDR the daemon will check again; the shape check here exists so an
/// option-shaped string never reaches the command line, not to second-guess the engine.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkCreateRequest {
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub driver: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub subnet: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub gateway: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub ip_range: String,
    #[serde(default)]
    pub ipv6: bool,
}

/// One Compose project as the project list shows it.
///
/// `config_files` is the engine's own sentence about where the project's files live; `services`
/// is the distinct services the project's containers carry, and `containers` is how many of those
/// containers exist including stopped ones.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeProject {
    pub name: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub config_files: String,
    pub services: u32,
    pub containers: u32,
}

/// One service of one Compose project, as the project's `ps` shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeServiceRow {
    pub id: String,
    pub name: String,
    pub service: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub health: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub status: String,
}
