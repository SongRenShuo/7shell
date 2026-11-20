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
}

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

/** The CPU weight presets the create dialog offers, in fnOS's three steps. */
export type ContainerCpuWeight = "high" | "normal" | "low";

export interface ContainerCreateRequest {
  readonly image: string;
  readonly name?: string;
  readonly ports?: readonly ContainerPortMapping[];
  readonly volumes?: readonly ContainerVolume[];
  readonly env?: readonly string[];
  readonly restartPolicy?: string;
  readonly command?: string;
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
