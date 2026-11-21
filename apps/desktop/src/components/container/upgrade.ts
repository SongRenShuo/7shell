/**
 * The container upgrade transaction: pull first, and nothing destructive until the pull has
 * answered.
 *
 * The order is the transaction's contract, and it is written here once so both the interface and
 * the spec can read it: pull the reference the container runs → stop the container → remove it →
 * create the replacement from the parameters the inspect read back → start it. A pull that failed
 * stops the transaction with the old container still running — a newer image that will not come
 * down is no reason to take the running one away. A pull that answered "up to date" stops the
 * transaction too: recreating would lose the container's own layer for nothing, so the old
 * container stays and the interface says so.
 *
 * Once the removal has happened the transaction is past the point of no return, and the outcome
 * says so: a create that fails leaves the old container gone and the new one unbuilt, with the
 * request kept — the same parameters, ready to be sent again — and the original image still on
 * the engine for a manual way back.
 *
 * The replacement's parameters come from the container's own inspect, item by item: the ports,
 * the mounts, the environment, the restart policy, the networks, the weights — what the engine
 * said the container runs with is what the replacement is asked to run with, and the spec asserts
 * that equality line by line.
 */
import type { ContainerCreateRequest, ContainerDetail, ContainerSummary } from "@/types/container";

/** One step of the transaction, as the backend sees it. Each resolves or rejects; nothing here
 * retries, because a retry is a decision the person sees, not one the transaction makes. */
export interface UpgradeSteps {
  /** Pulls the container's image reference, reporting each raw line the CLI prints. */
  pull(reference: string, onLine: (line: string) => void): Promise<void>;
  stop(): Promise<void>;
  remove(): Promise<void>;
  create(request: ContainerCreateRequest): Promise<void>;
  start(): Promise<void>;
}

/** Where the transaction is, while it runs, and where it stopped. */
export type UpgradePhase = "pulling" | "stopping" | "removing" | "creating" | "starting";

export type UpgradeOutcome =
  | { kind: "done" }
  | { kind: "upToDate" }
  | { kind: "failed"; phase: UpgradePhase; error: unknown };

/** Whether the pull's own lines said the image was already current. The CLI prints the sentence
 * when the tag had not moved; matching it here keeps the transaction from rebuilding a container
 * for nothing, which is the one outcome this verb cannot take back cheaply. */
export function pullReportedUpToDate(lines: readonly string[]): boolean {
  return lines.some((line) => /image is up to date/i.test(line));
}

/**
 * Runs the transaction in its order, answering what came of it.
 *
 * The order is fixed and the abort points are fixed with it: a pull failure and an up-to-date
 * answer both stop before `stop`, so the old container is untouched; a removal failure stops
 * before `create`, so the old container is still there; a create or start failure stops the
 * transaction with the removal already behind it, and the outcome's phase is how the interface
 * knows which recovery to offer — retry the create with the same request, or start the container
 * that did get built. The phase is named before its step runs, so the last name on record when a
 * step refuses is the step that refused.
 */
export async function runUpgradeTransaction(
  steps: UpgradeSteps,
  request: ContainerCreateRequest,
  events: { onPhase: (phase: UpgradePhase) => void },
): Promise<UpgradeOutcome> {
  let phase: UpgradePhase = "pulling";
  events.onPhase(phase);
  const lines: string[] = [];
  try {
    await steps.pull(request.image, (line) => lines.push(line));
    if (pullReportedUpToDate(lines)) {
      return { kind: "upToDate" };
    }
    phase = "stopping";
    events.onPhase(phase);
    await steps.stop();
    phase = "removing";
    events.onPhase(phase);
    await steps.remove();
    phase = "creating";
    events.onPhase(phase);
    await steps.create(request);
    phase = "starting";
    events.onPhase(phase);
    await steps.start();
    return { kind: "done" };
  } catch (error) {
    return { kind: "failed", phase, error };
  }
}

/**
 * The request the replacement runs with, read back from the container's own inspect.
 *
 * The curated detail carries the ports, mounts, environment and restart policy directly; the raw
 * document answers for the rest — the mount kinds (a named volume is remounted by its name, which
 * keeps it a volume rather than turning it into a bind), the networks, the labels, the weights,
 * the entrypoint and the terminal options. A raw document that will not parse costs exactly the
 * fields only it carries; the curated ones still build a container that runs.
 */
export function upgradeRequestFrom(container: ContainerSummary, detail: ContainerDetail): ContainerCreateRequest {
  interface RawMount {
    Type?: string;
    Name?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
    ReadOnly?: boolean;
  }
  interface RawDocument {
    Config?: {
      Labels?: Record<string, unknown>;
      Tty?: boolean;
      OpenStdin?: boolean;
      Entrypoint?: readonly string[];
      Cmd?: readonly string[];
    };
    HostConfig?: {
      Privileged?: boolean;
      CapAdd?: readonly string[];
      CpuShares?: number;
      Memory?: number;
      NetworkMode?: string;
    };
    NetworkSettings?: { Networks?: Record<string, unknown> };
    Mounts?: readonly RawMount[];
  }

  let privileged = false;
  let shares: number | null = null;
  let memoryBytes: number | null = null;
  let interactive = false;
  let tty = false;
  let entrypoint = detail.entrypoint;
  const capabilities: string[] = [];
  const labels: Record<string, string> = {};
  let networks: string[] = [];
  let mounts = detail.mounts.map((mount) => ({
    source: mount.source,
    destination: mount.destination,
    readOnly: mount.readOnly,
  }));
  try {
    const raw = JSON.parse(detail.raw) as RawDocument;
    privileged = raw.HostConfig?.Privileged === true;
    capabilities.push(...(raw.HostConfig?.CapAdd ?? []));
    if (typeof raw.HostConfig?.CpuShares === "number" && raw.HostConfig.CpuShares > 0) {
      shares = raw.HostConfig.CpuShares;
    }
    if (typeof raw.HostConfig?.Memory === "number" && raw.HostConfig.Memory > 0) {
      memoryBytes = raw.HostConfig.Memory;
    }
    interactive = raw.Config?.OpenStdin === true;
    tty = raw.Config?.Tty === true;
    const rawEntrypoint = raw.Config?.Entrypoint ?? [];
    if (rawEntrypoint.length > 0) {
      // The curated detail joins with spaces; the entrypoint is one word, and the join of several
      // is what the create surface's one-line field carries.
      entrypoint = rawEntrypoint.join(" ");
    }
    for (const [name, value] of Object.entries(raw.Config?.Labels ?? {})) {
      labels[name] = String(value);
    }
    networks = Object.keys(raw.NetworkSettings?.Networks ?? {});
    if (networks.length === 0 && raw.HostConfig?.NetworkMode && raw.HostConfig.NetworkMode !== "default") {
      networks = [raw.HostConfig.NetworkMode];
    }
    if (raw.Mounts && raw.Mounts.length > 0) {
      mounts = raw.Mounts.filter((mount) => (mount.Destination ?? "") !== "").map((mount) => ({
        // A named volume is remounted by its name, which keeps it a volume — mounting the engine's
        // own storage path would keep the data and lose the mount kind with it.
        source: (mount.Type === "volume" ? mount.Name : mount.Source) ?? "",
        destination: mount.Destination ?? "",
        readOnly: mount.RW === false || mount.ReadOnly === true,
      }));
    }
  } catch {
    // The raw document is an enhancement: the curated fields carry a working request alone.
  }

  return {
    image: container.image,
    name: container.name,
    ports: detail.ports.map((port) => ({
      hostIp: port.hostIp === "" ? undefined : port.hostIp,
      hostPort: Number(port.hostPort),
      containerPort: Number(port.containerPort),
      protocol: port.protocol,
    })),
    volumes: mounts
      .filter((mount) => mount.source !== "")
      .map((mount) => ({
        source: mount.source,
        destination: mount.destination,
        readOnly: mount.readOnly || undefined,
      })),
    env: [...detail.env],
    restartPolicy: detail.restartPolicy === "no" ? "" : detail.restartPolicy,
    entrypoint: entrypoint === "" ? undefined : entrypoint,
    command: detail.command,
    interactive,
    tty,
    privileged: privileged || undefined,
    capabilities: capabilities.length > 0 ? capabilities : undefined,
    networks: networks.length > 0 ? networks : undefined,
    memoryLimitMb: memoryBytes === null ? null : Math.round(memoryBytes / (1024 * 1024)),
    cpuWeight: shares === 768 ? "high" : shares === 256 ? "low" : shares === null ? null : "normal",
    labels: Object.keys(labels).length > 0 ? labels : null,
  };
}
