/**
 * The read-only conversion of a running container's inspect into a Compose service snippet.
 *
 * The conversion reads only — it restarts nothing and creates nothing; the snippet it hands back
 * is text for a person to look at, save and apply by their own hand. Its two promises are the ones
 * the plan sets:
 *
 * 1. **Nothing is dropped silently.** Every inspect field that carries something the engine was
 *    told to run with is either written into the snippet or named in `unresolved` — one line per
 *    parameter the Compose grammar (as this surface speaks it) cannot express, with the value it
 *    carries. A field that describes the container's runtime state rather than its spec (its
 *    sandbox paths, its assigned addresses, its attach wiring) is neither: that is not a parameter
 *    anybody asked for.
 * 2. **The snippet is YAML the engine would read.** Scalars that could be read as another type —
 *    a version number, a boolean word, a value with a colon or a comment in it — are quoted, the
 *    way a converter must quote when the destination parser decides types on its own.
 *
 * The curated detail carries the ports, the mounts, the environment and the restart policy
 * directly; the raw document answers for the rest, the same division the upgrade transaction's
 * request reader keeps. A raw document that will not parse costs exactly the fields only it
 * carries — the conversion still names what it had to leave out.
 */
import type { ContainerDetail } from "@/types/container";

/** What one container's inspect turns into. */
export interface ComposeServiceDraft {
  /** The service key the snippet writes, read from the container's name and made legal. */
  readonly serviceName: string;
  /** The snippet itself: a `services:` block with the one service under it. */
  readonly yaml: string;
  /** The inspect parameters the snippet could not express, named with their values. */
  readonly unresolved: readonly string[];
  /** Whether the raw inspect document was readable; false means the curated fields carried it. */
  readonly rawRead: boolean;
}

/** The grammar Compose service names keep; a container name outside it is folded into it. */
const SERVICE_NAME_PATTERN = /[^a-z0-9_-]+/g;

/** The name the service is written under: the container's, lowercased, with what the grammar
 * refuses folded to a dash. A name that folds to nothing is named "service" — the snippet is
 * edited before it is applied, and an editor can rename it. */
export function composeServiceName(containerName: string): string {
  const folded = containerName
    .toLowerCase()
    .replace(SERVICE_NAME_PATTERN, "-")
    .replace(/^[-_]+/, "");
  return folded === "" ? "service" : folded;
}

/** The download's name for one project's exported Compose file: the project's own, which the
 * project-name rule has already kept to filename-safe letters. */
export function composeExportFileName(projectName: string): string {
  return `${projectName}.compose.yml`;
}

/**
 * Quotes a scalar unless the destination parser would read a plain one back unchanged.
 *
 * A plain scalar is plain only when it is made of the characters YAML reads as text, and even then
 * only when it does not read as a number, a boolean or null — the parser decides types on its own,
 * and `8080:80` quoted is a port mapping while `8080:80` bare is a syntax error.
 */
function yamlScalar(value: string): string {
  const plain = /^[A-Za-z0-9_.+;^/:=~?-]+$/;
  const numeric = /^(?:0[xob][0-9a-fA-F_]+|[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?|\.inf|\.nan)$/;
  const wordy = /^(?:true|false|null|yes|no|on|off|~)$/i;
  if (value !== "" && !numeric.test(value) && !wordy.test(value) && !value.endsWith(":") && plain.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

/** One indent step, Compose's own. */
const INDENT = "  ";

interface RawPortBinding {
  HostIp?: string;
  HostPort?: string;
}

interface RawRestartPolicy {
  Name?: string;
  MaximumRetryCount?: number;
}

interface RawMount {
  Type?: string;
  Name?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
  ReadOnly?: boolean;
}

interface RawHealthcheck {
  Test?: readonly string[];
  Interval?: number;
  Timeout?: number;
  Retries?: number;
  StartPeriod?: number;
}

interface RawLogConfig {
  Type?: string;
  Config?: Record<string, string>;
}

interface RawUlimit {
  Name?: string;
  Soft?: number;
  Hard?: number;
}

interface RawNetworkSettings {
  Networks?: Record<
    string,
    {
      Aliases?: readonly string[];
      IPAMConfig?: { IPv4Address?: string; IPv6Address?: string };
      DriverOpts?: Record<string, string>;
      Links?: readonly string[] | null;
    }
  >;
}

interface RawDocument {
  Config?: {
    Hostname?: string;
    Domainname?: string;
    User?: string;
    WorkingDir?: string;
    Env?: readonly string[];
    Cmd?: readonly string[] | null;
    Entrypoint?: readonly string[] | null;
    Labels?: Record<string, unknown>;
    StopSignal?: string;
    StopTimeout?: number;
    Tty?: boolean;
    OpenStdin?: boolean;
    Healthcheck?: RawHealthcheck;
  };
  HostConfig?: {
    Binds?: readonly string[];
    Mounts?: readonly RawMount[];
    PortBindings?: Record<string, readonly RawPortBinding[] | null>;
    RestartPolicy?: RawRestartPolicy;
    NetworkMode?: string;
    Privileged?: boolean;
    CapAdd?: readonly string[] | null;
    CapDrop?: readonly string[] | null;
    Devices?: readonly { PathOnHost?: string; PathInContainer?: string; CgroupPermissions?: string }[];
    LogConfig?: RawLogConfig | null;
    Memory?: number;
    MemorySwap?: number;
    MemoryReservation?: number;
    CpuShares?: number;
    NanoCpus?: number;
    PidMode?: string;
    IpcMode?: string;
    OomKillDisable?: boolean;
    OomScoreAdj?: number;
    PidsLimit?: number;
    ReadonlyRootfs?: boolean;
    ShmSize?: number;
    Tmpfs?: Record<string, string> | readonly string[];
    Dns?: readonly string[];
    DnsSearch?: readonly string[];
    DnsOptions?: readonly string[];
    ExtraHosts?: readonly string[];
    SecurityOpt?: readonly string[];
    Sysctls?: Record<string, string>;
    Ulimits?: readonly RawUlimit[];
    GroupAdd?: readonly string[];
    CgroupParent?: string;
    Isolation?: string;
    Init?: boolean;
  };
  NetworkSettings?: RawNetworkSettings;
}

/**
 * The inspect sections the walk covers, and what each section's remaining keys mean.
 *
 * `handled` lists the keys the conversion writes into the snippet (so the leftover walk does not
 * name them twice). `ignored` lists the keys that carry runtime state or engine bookkeeping
 * rather than a parameter somebody set — a leftover walk that named those would be reporting
 * nothing anybody asked for.
 */
const HOST_CONFIG_HANDLED: ReadonlySet<string> = new Set([
  "Binds",
  "Mounts",
  "PortBindings",
  "RestartPolicy",
  "NetworkMode",
  "Privileged",
  "CapAdd",
  "CapDrop",
  "Devices",
  "LogConfig",
  "Memory",
  "MemorySwap",
  "MemoryReservation",
  "CpuShares",
  "NanoCpus",
  "PidMode",
  "IpcMode",
  "OomKillDisable",
  "OomScoreAdj",
  "PidsLimit",
  "ReadonlyRootfs",
  "ShmSize",
  "Tmpfs",
  "Dns",
  "DnsSearch",
  "DnsOptions",
  "ExtraHosts",
  "SecurityOpt",
  "Sysctls",
  "Ulimits",
  "GroupAdd",
  "CgroupParent",
  "Isolation",
  "Init",
]);
const HOST_CONFIG_IGNORED: ReadonlySet<string> = new Set([
  "ContainerIDFile",
  "MaskedPaths",
  "ReadonlyPaths",
  "ConsoleSize",
  "SandboxSize",
]);
const CONFIG_HANDLED: ReadonlySet<string> = new Set([
  "Hostname",
  "Domainname",
  "User",
  "WorkingDir",
  "Env",
  "Cmd",
  "Entrypoint",
  "Labels",
  "StopSignal",
  "StopTimeout",
  "Tty",
  "OpenStdin",
  "Healthcheck",
]);
const CONFIG_IGNORED: ReadonlySet<string> = new Set([
  "Image",
  "AttachStdin",
  "AttachStdout",
  "AttachStderr",
  "StdinOnce",
  "ArgsEscaped",
  "NetworkDisabled",
  "OnBuild",
  "Volumes",
  "ExposedPorts",
  "MacAddress",
  "VolumeDriver",
]);
const NETWORK_SETTINGS_HANDLED: ReadonlySet<string> = new Set(["Networks", "Ports"]);
const NETWORK_SETTINGS_IGNORED: ReadonlySet<string> = new Set([
  "IPAddress",
  "Gateway",
  "MacAddress",
  "Bridge",
  "SandboxID",
  "SandboxKey",
  "EndpointID",
  "HairpinMode",
  "LinkLocalIPv6Address",
  "GlobalIPv6Address",
  "SecondaryIPAddresses",
  "SecondaryIPv6Addresses",
  "GlobalIPv6PrefixLen",
  "IPPrefixLen",
  "IPv6Gateway",
  "TrafficDirection",
  "DefaultNetworkSettings",
]);

/** Nanoseconds, as the durations Compose reads: whole seconds, or milliseconds under one. */
function durationOf(nanos: number): string | null {
  if (typeof nanos !== "number" || nanos <= 0) {
    return null;
  }
  return nanos % 1_000_000_000 === 0 ? `${nanos / 1_000_000_000}s` : `${nanos / 1_000_000}ms`;
}

/** The modes a `networks:` list cannot carry: Compose reads these as network_mode, or refuses. */
const SPECIAL_NETWORK_MODES: ReadonlySet<string> = new Set(["default", "host", "none", "bridge", "nat"]);

/**
 * The builder the conversion writes the snippet with: lines gathered in order, one list of the
 * parameters the grammar could not carry alongside.
 */
class Snippet {
  private readonly lines: string[] = [];
  readonly unresolved: string[] = [];

  /** A scalar line at the given depth: `key: value`, both quoted when each must be. */
  scalar(indent: number, key: string, value: string): void {
    this.lines.push(`${INDENT.repeat(indent)}${yamlScalar(key)}: ${yamlScalar(value)}`);
  }

  /** A boolean line — bare `true`, never the quoted word the parser would read as a string. */
  bool(indent: number, key: string): void {
    this.lines.push(`${INDENT.repeat(indent)}${key}: true`);
  }

  /** A numeric line — bare digits, which is what the grammar's numbers are. */
  number(indent: number, key: string, value: number): void {
    this.lines.push(`${INDENT.repeat(indent)}${key}: ${value}`);
  }

  /** A line with nothing after it but the key — a list or a mapping opens under it. */
  opens(indent: number, key: string): void {
    this.lines.push(`${INDENT.repeat(indent)}${key}:`);
  }

  /** One list item: `- item`, with item items quoted when they must be. */
  item(indent: number, value: string): void {
    this.lines.push(`${INDENT.repeat(indent)}- ${yamlScalar(value)}`);
  }

  /** A raw line, already shaped — for the few forms the helpers above do not cut. */
  raw(line: string): void {
    this.lines.push(line);
  }

  /** A `key: {sub: value}` block, quoted per scalar, skipped entirely when empty. */
  mapping(indent: number, key: string, entries: readonly (readonly [string, string])[]): void {
    if (entries.length === 0) {
      return;
    }
    this.opens(indent, key);
    for (const [name, value] of entries) {
      this.scalar(indent + 1, name, value);
    }
  }

  /** A `key:` list, skipped entirely when empty. */
  list(indent: number, key: string, values: readonly string[]): void {
    if (values.length === 0) {
      return;
    }
    this.opens(indent, key);
    for (const value of values) {
      this.item(indent + 1, value);
    }
  }

  /** A `key:` list whose items are always quoted — the port mappings, which a bare
   * `8080:80` would hand to the YAML reader as a base-60 number on some parsers. */
  listQuoted(indent: number, key: string, values: readonly string[]): void {
    if (values.length === 0) {
      return;
    }
    this.opens(indent, key);
    for (const value of values) {
      this.lines.push(`${INDENT.repeat(indent + 1)}- ${JSON.stringify(value)}`);
    }
  }

  text(): string {
    return this.lines.join("\n");
  }
}

/** A mount the inspect carries, shaped for the snippet's short volume syntax. */
function mountSource(mount: RawMount): string {
  // A named volume keeps its name — mounting the engine's own storage path would keep the data
  // and lose the mount kind with it, the same reading the upgrade request keeps.
  return (mount.Type === "volume" ? mount.Name : mount.Source) ?? "";
}

function mountPath(mount: RawMount): string {
  return mount.Destination ?? "";
}

function mountReadOnly(mount: RawMount): boolean {
  return mount.RW === false || mount.ReadOnly === true;
}

/** The ports the raw bindings carry, as `"host:container/proto"` strings the snippet lists. */
function portExpressions(bindings: Record<string, readonly RawPortBinding[] | null>): string[] {
  const out: string[] = [];
  for (const [key, list] of Object.entries(bindings)) {
    const slash = key.indexOf("/");
    const container = slash >= 0 ? key.slice(0, slash) : key;
    const protocol = slash >= 0 ? key.slice(slash + 1) : "";
    for (const binding of list ?? []) {
      const hostIp = binding.HostIp ?? "";
      const hostPort = binding.HostPort ?? "";
      const head = hostIp !== "" ? `${hostIp}:` : "";
      out.push([`${head}${hostPort}:${container}`, protocol !== "" ? `/${protocol}` : ""].join(""));
    }
  }
  return out;
}

/** One snippet, or the honest account of why there is none. */
export function composeServiceFrom(detail: ContainerDetail): ComposeServiceDraft {
  const serviceName = composeServiceName(detail.name);
  const snippet = new Snippet();
  snippet.raw("services:");
  snippet.opens(1, serviceName);
  snippet.scalar(2, "image", detail.image);
  if (detail.name !== "") {
    snippet.scalar(2, "container_name", detail.name);
  }

  let raw: RawDocument | null = null;
  let rawRead = false;
  try {
    raw = JSON.parse(detail.raw) as RawDocument;
    rawRead = true;
  } catch {
    // The curated fields carry a working snippet alone; the walk below names what was lost.
    snippet.unresolved.push("inspect.raw unreadable — the fields only the raw document carries are not converted");
  }

  const config = raw?.Config;
  const host = raw?.HostConfig;
  const settings = raw?.NetworkSettings;

  // -- the plain scalars the curated detail already carries ------------------------
  if (detail.restartPolicy !== undefined && detail.restartPolicy !== "" && detail.restartPolicy !== "no") {
    const policy = host?.RestartPolicy;
    const retries =
      policy?.Name === "on-failure" && (policy?.MaximumRetryCount ?? 0) > 0 ? `:${policy?.MaximumRetryCount}` : "";
    snippet.scalar(2, "restart", `${detail.restartPolicy}${retries}`);
  }
  if (detail.user) {
    snippet.scalar(2, "user", detail.user);
  }
  if (detail.workDir) {
    snippet.scalar(2, "working_dir", detail.workDir);
  }

  // -- the raw document's own vocabulary, section by section ------------------------
  const hostname = config?.Hostname ?? "";
  if (hostname !== "") {
    snippet.scalar(2, "hostname", hostname);
  }
  const domainname = config?.Domainname ?? "";
  if (domainname !== "") {
    snippet.scalar(2, "domainname", domainname);
  }
  if (config?.Tty === true) {
    snippet.bool(2, "tty");
  }
  if (config?.OpenStdin === true) {
    snippet.bool(2, "stdin_open");
  }
  if (host?.Privileged === true) {
    snippet.bool(2, "privileged");
  }
  if (host?.ReadonlyRootfs === true) {
    snippet.bool(2, "read_only");
  }
  if (host?.Init === true) {
    snippet.bool(2, "init");
  }

  // The command and the entrypoint keep the list form: the inspect's words go back as words, so
  // an argument with a space in it survives the round trip.
  const command = config?.Cmd ?? null;
  if (command !== null && command !== undefined && command.length > 0) {
    snippet.raw(`${INDENT.repeat(2)}command: [${command.map((part) => yamlScalar(part)).join(", ")}]`);
  }
  const entrypoint = config?.Entrypoint ?? null;
  if (entrypoint !== null && entrypoint !== undefined && entrypoint.length > 0) {
    snippet.list(2, "entrypoint", entrypoint);
  }

  const env = config?.Env ?? detail.env;
  snippet.list(2, "environment", [...env]);

  const labels: (readonly [string, string])[] = [];
  for (const [name, value] of Object.entries(config?.Labels ?? {})) {
    // Compose writes its own bookkeeping labels on the containers it starts; carrying them into
    // the snippet would have the next `up` treat the project as a different one.
    if (name.startsWith("com.docker.compose.")) {
      continue;
    }
    labels.push([name, String(value)]);
  }
  snippet.mapping(2, "labels", labels);

  // The ports: the raw bindings when the document answers, the curated detail otherwise.
  const ports =
    host?.PortBindings !== undefined
      ? portExpressions(host.PortBindings)
      : detail.ports.map((port) => {
          const hostIp = port.hostIp !== "" ? `${port.hostIp}:` : "";
          const protocol = port.protocol !== "tcp" ? `/${port.protocol}` : "";
          return `${hostIp}${port.hostPort}:${port.containerPort}${protocol}`;
        });
  snippet.listQuoted(2, "ports", ports);

  // The mounts: the raw list keeps the volume/bind kind; the curated detail has the paths only.
  const rawMounts = host?.Mounts ?? null;
  const volumes = (
    rawMounts && rawMounts.length > 0
      ? rawMounts
      : detail.mounts.map((mount) => ({
          Type: "bind",
          Source: mount.source,
          Destination: mount.destination,
          RW: !mount.readOnly,
        }))
  )
    .map((mount) => {
      const source = mountSource(mount);
      const destination = mountPath(mount);
      if (source === "" || destination === "") {
        // A mount with no source or no destination is not a volume line; it is a leftover, and
        // the walk would not see it (it never sees the curated side) — name it here.
        snippet.unresolved.push(`Mounts = ${JSON.stringify(mount)} (no source or destination)`);
        return null;
      }
      const readOnly = mountReadOnly(mount) ? ":ro" : "";
      return `${source}:${destination}${readOnly}`;
    })
    .filter((line): line is string => line !== null);
  snippet.list(2, "volumes", volumes);

  // The networks: the runtime's keys are the network names. The default bridge is Compose's own,
  // and the special modes — host, none, and their Windows cousin — are written as network_mode,
  // because a networks list entry Compose has not declared external is a file the engine refuses.
  const networks = settings?.Networks ?? {};
  const names = Object.keys(networks).filter((name) => !SPECIAL_NETWORK_MODES.has(name));
  const hasStaticAddresses = names.some(
    (name) =>
      (networks[name]?.IPAMConfig?.IPv4Address ?? "") !== "" || (networks[name]?.IPAMConfig?.IPv6Address ?? "") !== "",
  );
  if (names.length > 0) {
    snippet.opens(2, "networks");
    for (const name of names) {
      const entry = networks[name];
      const aliases = (entry?.Aliases ?? []).filter((alias) => alias !== undefined);
      const driverOpts = Object.entries(entry?.DriverOpts ?? {});
      const links = (entry?.Links ?? []).filter((link): link is string => link !== undefined);
      const static4 = entry?.IPAMConfig?.IPv4Address ?? "";
      const static6 = entry?.IPAMConfig?.IPv6Address ?? "";
      if (!hasStaticAddresses && aliases.length === 0 && driverOpts.length === 0 && links.length === 0) {
        snippet.item(3, name);
        continue;
      }
      snippet.raw(`${INDENT.repeat(3)}${yamlScalar(name)}:`);
      if (static4 !== "") {
        snippet.scalar(4, "ipv4_address", static4);
      }
      if (static6 !== "") {
        snippet.scalar(4, "ipv6_address", static6);
      }
      snippet.list(4, "aliases", aliases);
      snippet.mapping(4, "driver_opts", driverOpts);
      snippet.list(4, "links", links);
    }
  }

  const networkMode = host?.NetworkMode ?? detail.networkMode ?? "";
  if (networkMode !== "" && SPECIAL_NETWORK_MODES.has(networkMode)) {
    if (networkMode !== "default") {
      snippet.scalar(2, "network_mode", networkMode);
    }
  } else if (networkMode !== "" && networks[networkMode] === undefined) {
    snippet.scalar(2, "network_mode", networkMode);
  }
  const pidMode = host?.PidMode ?? "";
  if (pidMode === "host") {
    snippet.scalar(2, "pid", "host");
  } else if (pidMode !== "") {
    snippet.unresolved.push(`HostConfig.PidMode = ${JSON.stringify(pidMode)}`);
  }
  const ipcMode = host?.IpcMode ?? "";
  if (ipcMode === "host" || ipcMode === "shareable") {
    snippet.scalar(2, "ipc", ipcMode);
  } else if (ipcMode !== "" && ipcMode !== "private") {
    snippet.unresolved.push(`HostConfig.IpcMode = ${JSON.stringify(ipcMode)}`);
  }

  snippet.list(2, "cap_add", [...(host?.CapAdd ?? [])]);
  snippet.list(2, "cap_drop", [...(host?.CapDrop ?? [])]);
  snippet.list(2, "group_add", [...(host?.GroupAdd ?? [])]);
  snippet.list(2, "security_opt", [...(host?.SecurityOpt ?? [])]);
  snippet.list(
    2,
    "devices",
    (host?.Devices ?? [])
      .map((device) => `${device.PathOnHost ?? ""}:${device.PathInContainer ?? ""}:${device.CgroupPermissions ?? ""}`)
      .filter((line) => line !== "::"),
  );
  snippet.list(2, "dns", [...(host?.Dns ?? [])]);
  snippet.list(2, "dns_search", [...(host?.DnsSearch ?? [])]);
  snippet.list(2, "dns_options", [...(host?.DnsOptions ?? [])]);
  snippet.list(2, "extra_hosts", [...(host?.ExtraHosts ?? [])]);
  snippet.mapping(2, "sysctls", Object.entries(host?.Sysctls ?? {}));
  const tmpfs = host?.Tmpfs;
  if (Array.isArray(tmpfs)) {
    snippet.list(2, "tmpfs", [...tmpfs]);
  } else if (tmpfs !== undefined) {
    snippet.mapping(2, "tmpfs", Object.entries(tmpfs));
  }
  if (host?.ShmSize !== undefined && host.ShmSize > 0) {
    snippet.number(2, "shm_size", host.ShmSize);
  }
  if (host?.Memory !== undefined && host.Memory > 0) {
    snippet.number(2, "mem_limit", host.Memory);
  }
  if (host?.MemorySwap !== undefined && host.MemorySwap > 0) {
    snippet.number(2, "memswap_limit", host.MemorySwap);
  }
  if (host?.MemoryReservation !== undefined && host.MemoryReservation > 0) {
    snippet.number(2, "mem_reservation", host.MemoryReservation);
  }
  if (host?.CpuShares !== undefined && host.CpuShares > 0) {
    snippet.number(2, "cpu_shares", host.CpuShares);
  }
  if (host?.NanoCpus !== undefined && host.NanoCpus > 0) {
    // The engine stores `--cpus` as nanoseconds; Compose reads the same share as a plain number.
    snippet.number(2, "cpus", host.NanoCpus / 1e9);
  }
  if (host?.OomKillDisable === true) {
    snippet.bool(2, "oom_kill_disable");
  }
  if (host?.OomScoreAdj !== undefined && host.OomScoreAdj !== 0) {
    snippet.number(2, "oom_score_adj", host.OomScoreAdj);
  }
  if (host?.PidsLimit !== undefined && host.PidsLimit > 0) {
    snippet.number(2, "pids_limit", host.PidsLimit);
  }
  if (host?.CgroupParent !== undefined && host.CgroupParent !== "") {
    snippet.scalar(2, "cgroup_parent", host.CgroupParent);
  }
  if (host?.Isolation !== undefined && host.Isolation !== "") {
    snippet.scalar(2, "isolation", host.Isolation);
  }
  const ulimits = (host?.Ulimits ?? []).filter((ulimit) => (ulimit.Name ?? "") !== "");
  if (ulimits.length > 0) {
    snippet.opens(2, "ulimits");
    for (const ulimit of ulimits) {
      const entries: (readonly [string, string])[] = [];
      if (ulimit.Soft !== undefined) {
        entries.push(["soft", String(ulimit.Soft)]);
      }
      if (ulimit.Hard !== undefined) {
        entries.push(["hard", String(ulimit.Hard)]);
      }
      snippet.mapping(3, ulimit.Name ?? "", entries);
    }
  }
  const log = host?.LogConfig;
  if (log?.Type !== undefined && log.Type !== "") {
    snippet.mapping(2, "logging", [["driver", log.Type]]);
    const options = Object.entries(log.Config ?? {});
    if (options.length > 0) {
      snippet.opens(3, "options");
      for (const [name, value] of options) {
        snippet.scalar(4, name, value);
      }
    }
  }
  const healthcheck = config?.Healthcheck;
  const tests = (healthcheck?.Test ?? []).filter((probe): probe is string => probe !== undefined);
  if (tests.length > 0) {
    snippet.opens(2, "healthcheck");
    if (tests.length === 1 && tests[0] === "NONE") {
      snippet.bool(3, "disable");
    } else {
      snippet.raw(`${INDENT.repeat(3)}test: [${tests.map((probe) => yamlScalar(probe)).join(", ")}]`);
      const interval = durationOf(healthcheck?.Interval ?? 0);
      if (interval !== null) {
        snippet.scalar(3, "interval", interval);
      }
      const timeout = durationOf(healthcheck?.Timeout ?? 0);
      if (timeout !== null) {
        snippet.scalar(3, "timeout", timeout);
      }
      const start = durationOf(healthcheck?.StartPeriod ?? 0);
      if (start !== null) {
        snippet.scalar(3, "start_period", start);
      }
      if ((healthcheck?.Retries ?? 0) > 0) {
        snippet.number(3, "retries", healthcheck?.Retries ?? 0);
      }
    }
  }
  const stopSignal = config?.StopSignal ?? "";
  if (stopSignal !== "" && stopSignal !== "SIGTERM") {
    snippet.scalar(2, "stop_signal", stopSignal);
  }
  const stopTimeout = config?.StopTimeout;
  if (stopTimeout !== undefined && stopTimeout > 0) {
    snippet.scalar(2, "stop_grace_period", `${stopTimeout}s`);
  }

  // -- the leftover walk: what neither side of the inspect mapped, named in full ------------
  const walk = (
    section: string,
    document: Record<string, unknown> | undefined,
    handled: ReadonlySet<string>,
    ignored: ReadonlySet<string>,
  ): void => {
    if (document === undefined || document === null) {
      return;
    }
    for (const [key, value] of Object.entries(document)) {
      if (handled.has(key) || ignored.has(key)) {
        continue;
      }
      if (value === null || value === false || value === "" || value === 0) {
        continue;
      }
      if (Array.isArray(value) && value.length === 0) {
        continue;
      }
      if (typeof value === "object" && Object.keys(value).length === 0) {
        continue;
      }
      const printed = JSON.stringify(value);
      snippet.unresolved.push(`${section}.${key} = ${printed.length > 160 ? `${printed.slice(0, 157)}...` : printed}`);
    }
  };
  walk("HostConfig", host as unknown as Record<string, unknown>, HOST_CONFIG_HANDLED, HOST_CONFIG_IGNORED);
  walk("Config", config as unknown as Record<string, unknown>, CONFIG_HANDLED, CONFIG_IGNORED);
  walk(
    "NetworkSettings",
    settings as unknown as Record<string, unknown>,
    NETWORK_SETTINGS_HANDLED,
    NETWORK_SETTINGS_IGNORED,
  );

  return {
    serviceName,
    yaml: snippet.text(),
    unresolved: snippet.unresolved,
    rawRead,
  };
}
