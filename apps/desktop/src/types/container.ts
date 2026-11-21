/**
 * Container wire types, mirroring `crates/sevenshell-types/src/container.rs`.
 *
 * Nothing here is a credential except the password on a registry login, and that one only travels
 * inward. Nothing here is a local path: archives are chosen in a native dialog and never named to
 * the interface.
 */

import type { SecretInput } from "@/types/session";

export type ContainerRuntime = "docker" | "podman" | "nerdctl" | "wslc";
export type ContainerTransport = "local" | "ssh";

export interface ContainerSettings {
  readonly runtime: ContainerRuntime;
  readonly transport: ContainerTransport;
  readonly sshSession?: string;
  readonly namespace?: string;
}

export interface ContainerSummary {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly ports: string;
  readonly createdAt: string;
  /**
   * The healthcheck verdict (`healthy`, `unhealthy`, `starting`), absent when the container has no
   * healthcheck at all — which is how the row knows to draw no badge. A runtime that does not
   * report health leaves it absent the same way.
   */
  readonly health?: string;
}

/** One event the engine's own `events` stream reported, mirroring `ContainerEvent` in Rust. */
export interface ContainerEvent {
  /** The engine's own kind word (`container`, `image`, …). Absent on the runtimes that say none. */
  readonly eventType?: string;
  /** The engine's own action word (`start`, `die`, `destroy`, …). */
  readonly action?: string;
  /** The id of the object the event is about; for container events, the container's id. */
  readonly id: string;
  /** The container's name when the event carried one. */
  readonly name?: string;
}

/**
 * What one container action came back as, mirroring `ContainerActionOutcome` in Rust. A race the
 * engine settled before we acted is `alreadySatisfied` — a success with a name, never an error.
 */
export type ContainerActionOutcome = "done" | "alreadySatisfied";

export interface ContainerPort {
  readonly hostIp?: string;
  readonly hostPort: string;
  readonly containerPort: string;
  readonly protocol: string;
}

export interface ContainerMount {
  readonly source: string;
  readonly destination: string;
  readonly readOnly: boolean;
}

export interface ContainerDetail {
  readonly id: string;
  readonly name: string;
  readonly image: string;
  readonly state: string;
  readonly status: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly exitCode?: number;
  readonly oomKilled: boolean;
  readonly pid: number;
  readonly restartPolicy?: string;
  readonly entrypoint?: string;
  readonly command?: string;
  readonly workDir?: string;
  readonly user?: string;
  readonly networkMode?: string;
  readonly ip?: string;
  readonly gateway?: string;
  readonly ports: readonly ContainerPort[];
  readonly mounts: readonly ContainerMount[];
  readonly env: readonly string[];
  readonly raw: string;
}

export interface ContainerImage {
  readonly id: string;
  readonly repository: string;
  readonly tag: string;
  readonly size: string;
  readonly createdAt: string;
}

export interface ImageLayer {
  readonly id: string;
  readonly createdBy: string;
  readonly size: string;
  readonly createdAt: string;
}

export interface ContainerStats {
  readonly id: string;
  readonly name: string;
  readonly cpuPercent: number;
  readonly memoryUsage: number;
  readonly memoryLimit: number;
  readonly memoryPercent: number;
  readonly networkInput: number;
  readonly networkOutput: number;
  readonly blockInput: number;
  readonly blockOutput: number;
  readonly pids: number;
}

export interface ContainerStateCount {
  readonly state: string;
  readonly count: number;
}

export interface ContainerRuntimeInfo {
  readonly runtime: string;
  readonly clientVersion?: string;
  readonly clientComponent?: string;
  readonly serverVersion?: string;
  readonly serverComponent?: string;
  readonly storageDriver?: string;
  readonly cgroupDriver?: string;
  readonly cgroupVersion?: string;
  readonly os?: string;
  readonly arch?: string;
  readonly kernel?: string;
  readonly cpus: number;
  readonly memory: number;
  readonly containersTotal: number;
  readonly containersByState: readonly ContainerStateCount[];
  readonly imagesTotal: number;
  readonly imagesTagged: number;
  readonly imagesDangling: number;
  /** Probed once when a desktop engine opened. Absent on connections that were never probed. */
  readonly composeAvailable?: boolean;
  /** A desktop engine is Docker by construction, so this arrives with the Compose bit. */
  readonly networkAvailable?: boolean;
  /**
   * Whether the engine's command line can answer a request for an image's remote digest — the
   * question behind the image page's "check for updates". Absent on connections that were never
   * probed, which reads as "may have it".
   */
  readonly manifestInspectAvailable?: boolean;
  /**
   * Whether the engine's `events` stream can be followed — the bit behind the container list's
   * automatic state updates. Probed once when a desktop engine opened; absent on connections that
   * were never probed. An engine without it is followed by hand, which is not an error and never
   * becomes a poll.
   */
  readonly eventsAvailable?: boolean;
  /**
   * Whether the engine's volume surface can be asked at all — the bit behind the volumes page.
   * Probed once when a desktop engine opened, network-free; absent on connections that were never
   * probed. An engine without it keeps its other pages and trims this one.
   */
  readonly volumeAvailable?: boolean;
}

/** The kinds of disk object the engine's `system df` counts, mirroring `ContainerDiskUsageKind`. */
export type ContainerDiskUsageKind = "images" | "containers" | "volumes" | "buildCache";

/**
 * One row of the engine's own `system df` answer, mirroring `ContainerDiskUsage` in Rust: how much
 * one kind of object occupies and how much of it the engine says it could give back.
 */
export interface ContainerDiskUsage {
  readonly kind: ContainerDiskUsageKind;
  readonly count: number;
  readonly size: number;
  readonly reclaimable: number;
}

/**
 * One volume as the volumes page shows it, mirroring `VolumeSummary` in Rust. The page is a
 * reader, not a maker — there is no create here, and the only verb is a removal the engine itself
 * refuses while a container still holds the volume.
 */
export interface VolumeSummary {
  readonly name: string;
  readonly driver: string;
  readonly mountpoint: string;
  /** The size the engine printed, when its listing prints sizes at all; empty means it gave none. */
  readonly size?: string;
  readonly createdAt?: string;
}

/**
 * What one prune came back with, mirroring `ContainerPruneReport` in Rust: the bytes the engine
 * says it gave back and the objects it named while doing it.
 */
export interface ContainerPruneReport {
  readonly reclaimed: number;
  readonly deleted?: readonly string[];
}

/**
 * Where the engine pulls from, mirroring `ContainerRegistrySettings` in the Rust types.
 *
 * Every field is optional because the Rust side skips it when empty: a daemon with no mirrors and
 * no proxy answers the empty shape, which is the honest answer, not an error.
 */
export interface ContainerRegistrySettings {
  /** The pull-through mirrors the daemon consults before the upstream registry, in order. */
  readonly mirrors?: readonly string[];
  readonly httpProxy?: string;
  readonly httpsProxy?: string;
  readonly noProxy?: string;
}

/**
 * The remote digest of one image tag, beside the digests the engine recorded locally, mirroring
 * `ContainerImageRemoteDigest` in the Rust types.
 *
 * `upToDate` is answered only when both sides answered: a registry that would not speak and an
 * image loaded from an archive are both honest absences, not a guess either way.
 */
export interface ContainerImageRemoteDigest {
  readonly reference: string;
  /** The digest the registry serves for this tag, as the engine would pull it. */
  readonly remoteDigest?: string;
  /** The digests the engine recorded for this image's pulls (`RepoDigests`). */
  readonly localDigests?: readonly string[];
  readonly upToDate?: boolean;
  /** Which registry answered: a mirror host, or `upstream` when the engine's own index did. */
  readonly source?: string;
}

export interface ContainerStreamLine {
  readonly streamId: string;
  readonly line: string;
}

export interface ContainerStreamEnd {
  readonly streamId: string;
  readonly error?: string;
  /**
   * Which holder the backend spent to free a channel for something else — the events stream is
   * the one that yields. The stream did not fail: follow the list by refreshing instead, and do
   * not reconnect on your own.
   */
  readonly yielded?: string;
}

/** One holder kind and how many channels it holds on a connection. */
export interface ContainerChannelHolders {
  /** The holder's name in the budget's own vocabulary: `events`, `logs`, `pty` or `exec`. */
  readonly kind: string;
  readonly held: number;
}

/**
 * How full a connection's channel budget is, and who is holding the rest.
 *
 * `null` from the backend means the engine runs on this machine: a local command holds no SSH
 * channel, so there is no budget to read and no open to refuse.
 */
export interface ContainerChannelBudget {
  readonly limit: number;
  readonly held: number;
  readonly free: number;
  readonly holders?: readonly ContainerChannelHolders[];
}

export interface ContainerPortMapping {
  readonly hostIp?: string;
  readonly hostPort: number;
  readonly containerPort: number;
  readonly protocol?: string;
}

export interface ContainerVolume {
  readonly source: string;
  readonly destination: string;
  /** Mount the volume read-only (`:ro`). Absent means read-write. */
  readonly readOnly?: boolean;
}

/** The CPU weight presets the create dialog offers, in the reference's three steps. */
export type ContainerCpuWeight = "high" | "normal" | "low";

export interface ContainerCreateRequest {
  readonly image: string;
  readonly name?: string;
  readonly ports?: readonly ContainerPortMapping[];
  readonly volumes?: readonly ContainerVolume[];
  readonly env?: readonly string[];
  readonly restartPolicy?: string;
  readonly command?: string;
  /** The entrypoint the container runs instead of the image's own. Absent leaves the default. */
  readonly entrypoint?: string;
  readonly interactive?: boolean;
  readonly tty?: boolean;
  /** Run with the host's device access (`--privileged`). */
  readonly privileged?: boolean;
  /** One Linux capability per `--cap-add`, e.g. `NET_ADMIN`. */
  readonly capabilities?: readonly string[];
  /** One network per `--network`, in the order the wizard listed them. */
  readonly networks?: readonly string[];
  /** The memory ceiling in MiB; the engine converts it to bytes. `null` leaves it unset. */
  readonly memoryLimitMb?: number | null;
  /** The CPU weight preset, or `null` for the runtime's default. */
  readonly cpuWeight?: ContainerCpuWeight | null;
  /** Labels written as remarks. `null` leaves them unset. */
  readonly labels?: Record<string, string> | null;
}

export interface ContainerImageTransfer {
  readonly image: string;
  readonly platform?: string;
  readonly allTags?: boolean;
  readonly insecure?: boolean;
}

export interface ContainerRegistryLogin {
  readonly registry?: string;
  readonly username: string;
  readonly secret: SecretInput;
  readonly insecure?: boolean;
}

export interface ContainerCommitRequest {
  readonly containerId: string;
  readonly image: string;
  readonly author?: string;
  readonly message?: string;
}

/**
 * Docker network wire types, mirroring `NetworkSummary`/`NetworkCreateRequest` in the Rust types.
 *
 * The address fields may be absent: the built-in networks answer them from the inspect, but a
 * network whose driver has no IPAM at all does not. Read every optional one as "may not be there".
 */
export interface NetworkSummary {
  readonly name: string;
  readonly driver: string;
  readonly scope?: string;
  readonly subnet?: string;
  readonly gateway?: string;
  readonly ipRange?: string;
  readonly ipv6: boolean;
  readonly internal: boolean;
  /** How many containers are attached; the removal guardrail reads the same number. */
  readonly containers: number;
}

export interface NetworkCreateRequest {
  readonly name: string;
  readonly driver?: string;
  readonly subnet?: string;
  readonly gateway?: string;
  readonly ipRange?: string;
  readonly ipv6?: boolean;
}

/** One Compose project as the project list shows it. */
export interface ComposeProject {
  readonly name: string;
  readonly status: string;
  readonly configFiles?: string;
  readonly services: number;
  readonly containers: number;
}

/** One service of one Compose project, as the project's `ps` shows it. */
export interface ComposeServiceRow {
  readonly id: string;
  readonly name: string;
  readonly service: string;
  readonly state: string;
  readonly health?: string;
  readonly status?: string;
}
