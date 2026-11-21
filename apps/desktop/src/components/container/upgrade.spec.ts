/**
 * The upgrade transaction's contract, and the parameters the replacement runs with.
 *
 * Two assertions here carry the whole batch: the order — a pull that failed never reaches the
 * removal, and a pull that answers "up to date" stops before the container is even stopped — and
 * the parameter equality, read back from a container's inspect item by item: ports, mounts (named
 * volumes by name, binds by path), environment, restart policy, networks, entrypoint and command,
 * the weights, the labels. What the engine said the container runs with is what the replacement is
 * asked to run with.
 *
 * The steps are a recorder, so the assertions read the calls the transaction actually made in the
 * order it made them.
 */
import { describe, expect, it } from "vitest";

import type { ContainerDetail, ContainerSummary } from "@/types/container";

import {
  pullReportedUpToDate,
  runUpgradeTransaction,
  upgradeRequestFrom,
  type UpgradeOutcome,
  type UpgradePhase,
  type UpgradeSteps,
} from "./upgrade";

/** A recorder that walks one script of refusals, in the order the steps were called. */
function recorder(failures: Readonly<Record<string, unknown>> = {}) {
  const calls: string[] = [];
  const requests: unknown[] = [];
  const steps: UpgradeSteps = {
    async pull(_reference, onLine) {
      calls.push("pull");
      onLine("Step 1/4 : FROM nginx");
      const failure = failures.pull;
      if (failure !== undefined) {
        throw failure;
      }
    },
    async stop() {
      calls.push("stop");
      const failure = failures.stop;
      if (failure !== undefined) {
        throw failure;
      }
    },
    async remove() {
      calls.push("remove");
      const failure = failures.remove;
      if (failure !== undefined) {
        throw failure;
      }
    },
    async create(request) {
      calls.push("create");
      requests.push(request);
      const failure = failures.create;
      if (failure !== undefined) {
        throw failure;
      }
    },
    async start() {
      calls.push("start");
      const failure = failures.start;
      if (failure !== undefined) {
        throw failure;
      }
    },
  };
  return { steps, calls, requests };
}

const REQUEST = { image: "nginx:1.27", name: "web" } as Parameters<typeof runUpgradeTransaction>[1];

function run(steps: UpgradeSteps): Promise<UpgradeOutcome> {
  return runUpgradeTransaction(steps, REQUEST, { onPhase: () => {} });
}

describe("the upgrade transaction's order", () => {
  it("pulls first, then stops, removes, creates and starts, in that order and no other", async () => {
    const { steps, calls } = recorder();
    const outcome = await run(steps);
    expect(outcome).toEqual({ kind: "done" });
    expect(calls).toEqual(["pull", "stop", "remove", "create", "start"]);
  });

  it("never touches the old container when the pull fails", async () => {
    const { steps, calls } = recorder({ pull: new Error("manifest unknown") });
    const outcome = await run(steps);
    expect(outcome).toEqual({ kind: "failed", phase: "pulling", error: expect.anything() });
    expect(calls, "a pull that will not come down is no reason to stop or remove what runs").toEqual(["pull"]);
  });

  it("never touches the old container when the pull says the image is already current", async () => {
    const { steps, calls } = recorder();
    const outcome = await runUpgradeTransaction(
      {
        ...steps,
        async pull(_reference, onLine) {
          calls.push("pull");
          onLine("Status: Image is up to date for nginx:1.27");
        },
      },
      REQUEST,
      { onPhase: () => {} },
    );
    expect(outcome).toEqual({ kind: "upToDate" });
    expect(calls, "rebuilding for nothing costs the container's own layer").toEqual(["pull"]);
  });

  it("stops before the removal when the stop refuses, and the old container is still there", async () => {
    const { steps, calls } = recorder({ stop: new Error("the container is restarting") });
    const outcome = await run(steps);
    expect(outcome).toEqual({ kind: "failed", phase: "stopping", error: expect.anything() });
    expect(calls).toEqual(["pull", "stop"]);
  });

  it("stops before the create when the removal refuses", async () => {
    const { steps, calls } = recorder({ remove: new Error("cannot remove a running container") });
    const outcome = await run(steps);
    expect(outcome).toEqual({ kind: "failed", phase: "removing", error: expect.anything() });
    expect(calls).toEqual(["pull", "stop", "remove"]);
  });

  it("sends the same request again on a create failure, and starts nothing that was not built", async () => {
    const { steps, calls, requests } = recorder({ create: new Error("the name is in use") });
    const outcome = await run(steps);
    expect(outcome).toEqual({ kind: "failed", phase: "creating", error: expect.anything() });
    expect(calls).toEqual(["pull", "stop", "remove", "create"]);
    expect(requests, "the retry is the same parameters, not a rebuild of them").toEqual([REQUEST]);
  });

  it("answers the phase it stopped in, so the interface knows which recovery to offer", async () => {
    const phases: UpgradePhase[] = [];
    const { steps } = recorder({ start: new Error("the port is taken") });
    const outcome = await runUpgradeTransaction(steps, REQUEST, { onPhase: (phase) => phases.push(phase) });
    expect(outcome).toEqual({ kind: "failed", phase: "starting", error: expect.anything() });
    expect(phases).toEqual(["pulling", "stopping", "removing", "creating", "starting"]);
  });
});

describe("the pull's own answer", () => {
  it("reads the up-to-date sentence out of the lines the CLI printed", () => {
    expect(pullReportedUpToDate(["Status: Image is up to date for nginx:1.27"])).toBe(true);
    expect(pullReportedUpToDate(["Status: Downloaded newer image for nginx:1.27"])).toBe(false);
    expect(pullReportedUpToDate([])).toBe(false);
  });
});

/** A container row and the inspect the engine answered for it, in the shapes the pane passes on. */
function fixture(): { container: ContainerSummary; detail: ContainerDetail } {
  return {
    container: {
      id: "abc123",
      name: "web",
      image: "nginx:1.27",
      state: "running",
      status: "Up 2 hours",
      ports: "0.0.0.0:8080->80/tcp",
      createdAt: "2026-11-10 10:00:00",
    },
    detail: {
      id: "abc123",
      name: "/web",
      image: "nginx:1.27",
      state: "running",
      status: "Up 2 hours",
      restartPolicy: "always",
      entrypoint: "/docker-entrypoint.sh",
      command: "nginx -g daemon off;",
      networkMode: "custom-net",
      ip: "172.30.0.2",
      gateway: "172.30.0.1",
      ports: [
        { hostIp: "0.0.0.0", hostPort: "8080", containerPort: "80", protocol: "tcp" },
        { hostIp: "", hostPort: "9090", containerPort: "9090", protocol: "udp" },
      ],
      mounts: [
        // The curated mount flattens the kind away; the raw document below is what answers.
        { source: "/var/lib/docker/volumes/site-data/_data", destination: "/srv/site", readOnly: false },
      ],
      env: ["NGINX_VERSION=1.27", "MODE=fast"],
      oomKilled: false,
      pid: 12,
      raw: JSON.stringify({
        Config: {
          Tty: true,
          OpenStdin: false,
          Labels: { team: "infra", "com.docker.compose.project": "web" },
        },
        HostConfig: {
          Privileged: false,
          CapAdd: ["NET_ADMIN"],
          CpuShares: 768,
          Memory: 268435456,
          NetworkMode: "custom-net",
        },
        NetworkSettings: {
          Networks: { "custom-net": {}, "backup-net": {} },
        },
        Mounts: [
          {
            Type: "volume",
            Name: "site-data",
            Source: "/var/lib/docker/volumes/site-data/_data",
            Destination: "/srv/site",
            RW: true,
          },
          {
            Type: "volume",
            Name: "022bc8aa9fdd1e2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e",
            Source: "/var/lib/docker/volumes/022b/_data",
            Destination: "/tmp/cache",
            RW: true,
          },
          { Type: "bind", Source: "/srv/conf/nginx.conf", Destination: "/etc/nginx/nginx.conf", RW: false },
        ],
      }),
    },
  };
}

describe("the parameters the replacement runs with", () => {
  const { container, detail } = fixture();
  const request = upgradeRequestFrom(container, detail);

  it("runs the same image under the same name", () => {
    expect(request.image).toBe("nginx:1.27");
    expect(request.name).toBe("web");
  });

  it("maps every published port back, host address included", () => {
    expect(request.ports).toEqual([
      { hostIp: "0.0.0.0", hostPort: 8080, containerPort: 80, protocol: "tcp" },
      { hostIp: undefined, hostPort: 9090, containerPort: 9090, protocol: "udp" },
    ]);
  });

  it("remounts named volumes by name and anonymous ones by their own, binds by path, and keeps the read-only flag", () => {
    expect(request.volumes).toEqual([
      { source: "site-data", destination: "/srv/site", readOnly: undefined },
      {
        source: "022bc8aa9fdd1e2c3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e",
        destination: "/tmp/cache",
        readOnly: undefined,
      },
      { source: "/srv/conf/nginx.conf", destination: "/etc/nginx/nginx.conf", readOnly: true },
    ]);
  });

  it("carries the environment verbatim", () => {
    expect(request.env).toEqual(["NGINX_VERSION=1.27", "MODE=fast"]);
  });

  it("carries the restart policy the engine said, with the default said as nothing", () => {
    expect(request.restartPolicy).toBe("always");
  });

  it("carries the entrypoint and the command the inspect read back", () => {
    expect(request.entrypoint).toBe("/docker-entrypoint.sh");
    expect(request.command).toBe("nginx -g daemon off;");
  });

  it("carries every network the container was on", () => {
    expect(request.networks).toEqual(["custom-net", "backup-net"]);
  });

  it("reads the weights, the capabilities and the labels off the raw document", () => {
    expect(request.cpuWeight, "768 shares is the reference's high step").toBe("high");
    expect(request.memoryLimitMb).toBe(256);
    expect(request.capabilities).toEqual(["NET_ADMIN"]);
    expect(request.labels).toEqual({ team: "infra", "com.docker.compose.project": "web" });
    expect(request.privileged).toBeUndefined();
    expect(request.interactive).toBe(false);
    expect(request.tty).toBe(true);
  });

  it("falls back to the curated detail when the raw document does not parse", () => {
    const degraded = upgradeRequestFrom(container, {
      ...detail,
      raw: "{not json",
      entrypoint: "",
    });
    expect(degraded.entrypoint).toBeUndefined();
    expect(degraded.volumes).toEqual([
      { source: "/var/lib/docker/volumes/site-data/_data", destination: "/srv/site", readOnly: undefined },
    ]);
    expect(degraded.cpuWeight).toBeNull();
  });
});
