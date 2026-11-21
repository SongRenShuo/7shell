/**
 * The run→compose conversion, as a promise about honesty rather than about coverage.
 *
 * What is checked is what a lazy converter would do: drop a parameter the inspect carried, invent
 * a YAML line the engine would misread, hand back a service name the grammar refuses, or claim
 * completeness while the raw document was never read. Every conversion here is read-only — the
 * spec feeds the detail; nothing else runs.
 */
import { describe, expect, it } from "vitest";

import { composeExportFileName, composeServiceFrom, composeServiceName } from "@/components/container/composeRun";
import type { ContainerDetail } from "@/types/container";

/** A detail with the curated fields filled and a raw document the caller shapes per test. */
function detailOf(raw: unknown, overrides: Partial<ContainerDetail> = {}): ContainerDetail {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "web-app",
    image: "nginx:latest",
    state: "running",
    status: "Up 2 hours",
    oomKilled: false,
    pid: 1234,
    restartPolicy: "always",
    ports: [],
    mounts: [],
    env: [],
    raw: JSON.stringify(raw),
    ...overrides,
  };
}

describe("the service name and the file names", () => {
  it("folds a container name the grammar refuses into a service name", () => {
    expect(composeServiceName("web-app")).toBe("web-app");
    expect(composeServiceName("Web App.1")).toBe("web-app-1");
    expect(composeServiceName("--!!")).toBe("service");
  });

  it("names the export after the project it came from", () => {
    expect(composeExportFileName("web-app")).toBe("web-app.compose.yml");
  });
});

describe("the snippet", () => {
  it("carries the image, the container's name, and the restart policy", () => {
    const draft = composeServiceFrom(detailOf({}));
    expect(draft.yaml).toContain("services:");
    expect(draft.yaml).toContain("  web-app:");
    expect(draft.yaml).toContain("image: nginx:latest");
    expect(draft.yaml).toContain("container_name: web-app");
    expect(draft.yaml).toContain("restart: always");
    expect(draft.rawRead).toBe(true);
    expect(draft.unresolved).toEqual([]);
  });

  it("keeps a retry count the restart policy carries", () => {
    const draft = composeServiceFrom(
      detailOf(
        { HostConfig: { RestartPolicy: { Name: "on-failure", MaximumRetryCount: 3 } } },
        {
          restartPolicy: "on-failure",
        },
      ),
    );
    expect(draft.yaml).toContain("restart: on-failure:3");
  });

  it("writes the ports, with the host ip and the protocol when the engine said them", () => {
    const draft = composeServiceFrom(
      detailOf(
        {
          HostConfig: {
            PortBindings: {
              "80/tcp": [{ HostIp: "", HostPort: "8080" }],
              "53/udp": [{ HostIp: "127.0.0.1", HostPort: "9053" }],
            },
          },
        },
        {
          ports: [
            { hostIp: "", hostPort: "8080", containerPort: "80", protocol: "tcp" },
            { hostIp: "127.0.0.1", hostPort: "9053", containerPort: "53", protocol: "udp" },
          ],
        },
      ),
    );
    expect(draft.yaml).toContain('- "8080:80/tcp"');
    expect(draft.yaml).toContain('- "127.0.0.1:9053:53/udp"');
  });

  it("keeps a named volume a volume and a bind a bind, read-only where it is", () => {
    const draft = composeServiceFrom(
      detailOf(
        {
          HostConfig: {
            Mounts: [
              { Type: "volume", Name: "webdata", Destination: "/var/www", RW: true },
              { Type: "bind", Source: "/srv/conf", Destination: "/etc/nginx", RW: false },
            ],
          },
        },
        {
          mounts: [
            { source: "webdata", destination: "/var/www", readOnly: false },
            { source: "/srv/conf", destination: "/etc/nginx", readOnly: true },
          ],
        },
      ),
    );
    expect(draft.yaml).toContain("- webdata:/var/www");
    expect(draft.yaml).toContain("- /srv/conf:/etc/nginx:ro");
  });

  it("writes the environment and the labels, without Compose's own bookkeeping labels", () => {
    const draft = composeServiceFrom(
      detailOf(
        {
          Config: {
            Env: ["NGINX_PORT=80", "PATH=/usr/local/sbin:/usr/local/bin"],
            Labels: {
              "com.docker.compose.project": "web-app",
              "com.docker.compose.service": "web",
              "my.label": "keep me",
            },
          },
        },
        { env: ["NGINX_PORT=80"] },
      ),
    );
    expect(draft.yaml).toContain("- NGINX_PORT=80");
    expect(draft.yaml).toContain('my.label: "keep me"');
    expect(draft.yaml).not.toContain("com.docker.compose.project");
    // The engine's own labels are bookkeeping, not parameters: dropped on purpose, and the
    // leftover walk does not name them either.
    expect(draft.unresolved).toEqual([]);
  });

  it("lists the networks a snippet may name, and writes the special modes as network_mode", () => {
    const draft = composeServiceFrom(
      detailOf({
        HostConfig: { NetworkMode: "host" },
        NetworkSettings: { Networks: { host: {} } },
      }),
    );
    expect(draft.yaml).toContain("network_mode: host");
    expect(draft.yaml).not.toContain("networks:");

    const joined = composeServiceFrom(
      detailOf({
        HostConfig: { NetworkMode: "webnet" },
        NetworkSettings: {
          Networks: {
            webnet: { Aliases: ["alias-a"], IPAMConfig: { IPv4Address: "10.0.0.5" } },
            default: {},
          },
        },
      }),
    );
    expect(joined.yaml).toContain("networks:");
    expect(joined.yaml).toContain("webnet:");
    expect(joined.yaml).toContain("ipv4_address: 10.0.0.5");
    expect(joined.yaml).toContain("- alias-a");
    expect(joined.yaml).not.toContain("default");
  });

  it("writes the resource limits, the capabilities, and the process shape", () => {
    const draft = composeServiceFrom(
      detailOf(
        {
          Config: {
            Tty: true,
            OpenStdin: true,
            WorkingDir: "/app",
            User: "1000:1000",
            Hostname: "web-host",
            Cmd: ["nginx", "-g", "daemon off;"],
            Entrypoint: ["/docker-entrypoint.sh"],
          },
          HostConfig: {
            Privileged: true,
            CapAdd: ["SYS_ADMIN", "NET_ADMIN"],
            Memory: 536870912,
            CpuShares: 512,
            NanoCpus: 1500000000,
          },
        },
        { workDir: "/app", user: "1000:1000" },
      ),
    );
    expect(draft.yaml).toContain("tty: true");
    expect(draft.yaml).toContain("stdin_open: true");
    expect(draft.yaml).toContain("working_dir: /app");
    expect(draft.yaml).toContain("user: 1000:1000");
    expect(draft.yaml).toContain("hostname: web-host");
    expect(draft.yaml).toContain('command: [nginx, -g, "daemon off;"]');
    expect(draft.yaml).toContain("entrypoint:");
    expect(draft.yaml).toContain("- /docker-entrypoint.sh");
    expect(draft.yaml).toContain("privileged: true");
    expect(draft.yaml).toContain("- SYS_ADMIN");
    expect(draft.yaml).toContain("mem_limit: 536870912");
    expect(draft.yaml).toContain("cpu_shares: 512");
    expect(draft.yaml).toContain("cpus: 1.5");
  });

  it("writes the healthcheck, with the durations the engine measured in", () => {
    const draft = composeServiceFrom(
      detailOf({
        Config: {
          Healthcheck: {
            Test: ["CMD-SHELL", "curl -f http://localhost || exit 1"],
            Interval: 30_000_000_000,
            Timeout: 5_000_000_000,
            Retries: 3,
            StartPeriod: 10_500_000_000,
          },
        },
      }),
    );
    expect(draft.yaml).toContain("healthcheck:");
    expect(draft.yaml).toContain('test: [CMD-SHELL, "curl -f http://localhost || exit 1"]');
    expect(draft.yaml).toContain("interval: 30s");
    expect(draft.yaml).toContain("timeout: 5s");
    expect(draft.yaml).toContain("start_period: 10500ms");
    expect(draft.yaml).toContain("retries: 3");
  });

  it("quots a scalar the parser would read as another type", () => {
    const draft = composeServiceFrom(
      detailOf({ Config: { Env: ["FLAG=true", "LOOKS_NUMERIC=42", "HAS_COLON=a: b"] } }),
    );
    // "=" and a colon with no space after it read back as the same string bare; a colon with a
    // space in it is a mapping the parser would see, so it travels quoted.
    expect(draft.yaml).toContain("- FLAG=true");
    expect(draft.yaml).toContain("- LOOKS_NUMERIC=42");
    expect(draft.yaml).toContain('- "HAS_COLON=a: b"');
  });
});

describe("the unresolved list", () => {
  it("names what the grammar cannot express, with the value it carries", () => {
    const draft = composeServiceFrom(
      detailOf({
        HostConfig: {
          AutoRemove: true,
          CpuQuota: 50000,
          PidMode: "container:abc123",
          UTSMode: "private",
        },
      }),
    );
    expect(draft.unresolved.some((line) => line.includes("HostConfig.AutoRemove = true"))).toBe(true);
    expect(draft.unresolved.some((line) => line.includes("HostConfig.CpuQuota = 50000"))).toBe(true);
    expect(draft.unresolved.some((line) => line.includes('HostConfig.PidMode = "container:abc123"'))).toBe(true);
    expect(draft.unresolved.some((line) => line.includes("HostConfig.UTSMode"))).toBe(true);
  });

  it("says nothing when the inspect carried nothing to leave out", () => {
    const draft = composeServiceFrom(detailOf({ HostConfig: {}, Config: {}, NetworkSettings: {} }));
    expect(draft.unresolved).toEqual([]);
  });

  it("says the raw document was unreadable rather than claiming the fields were carried", () => {
    const draft = composeServiceFrom(detailOf({}, { raw: "{not json" }));
    expect(draft.rawRead).toBe(false);
    expect(draft.unresolved.length).toBe(1);
    expect(draft.unresolved[0]).toContain("unreadable");
  });

  it("keeps runtime state out of the list — it was never a parameter", () => {
    const draft = composeServiceFrom(
      detailOf({
        Id: "abc",
        Created: "2026-01-01T00:00:00Z",
        Path: "nginx",
        ResolvConfPath: "/var/lib/docker/containers/abc/resolv.conf",
        State: { Running: true, Pid: 1234 },
        HostConfig: { MaskedPaths: ["/proc/acpi"], ContainerIDFile: "" },
        Config: { AttachStdout: true, StdinOnce: false },
        NetworkSettings: { IPAddress: "172.17.0.2", Bridge: "docker0", SandboxKey: "/var/run/netns/c1" },
      }),
    );
    expect(draft.unresolved).toEqual([]);
  });
});
