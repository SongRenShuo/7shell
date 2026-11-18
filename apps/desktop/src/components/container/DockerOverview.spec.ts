/**
 * The desktop overview, as a person reads it: what the engine holds in three pressable rows, the
 * lamp saying whether it is well, and the three short lines drawn from what the engine reported.
 *
 * The summary rows and the lamp are DOM facts; the sampling is asserted through the backend mock —
 * one answer on mount, another each interval while the page is visible, and silence when it is
 * not, because "nobody watching, nothing sampled" is the discipline the monitor's panel taught
 * and this page keeps.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerStats: vi.fn(async () => []),
  containerList: vi.fn(async () => []),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(async () => ({
    runtime: "docker",
    cpus: 2,
    memory: 1024,
    containersTotal: 0,
    containersByState: [],
    imagesTotal: 0,
    imagesTagged: 0,
    imagesDangling: 0,
  })),
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

import DockerOverview from "@/components/container/DockerOverview.vue";
import { SAMPLE_INTERVAL_MS } from "@/components/container/dockerMetrics";
import { i18n } from "@/i18n";
import { containerStats } from "@/lib/backend/tauri";
import type { ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerStats } from "@/types/container";

const statsMock = vi.mocked(containerStats);

let app: App | undefined;
let host: HTMLDivElement | undefined;
let selectedStates: (string | null)[];
let imagesShown = 0;

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-overview",
    session: {
      id: "session-overview",
      name: "lab engine",
      protocol: "container",
      host: "",
      port: 0,
      user: "",
      auth: { method: "password", hasSecret: false },
      terminal: { terminalType: "xterm-256color", keepaliveSeconds: 0, forwardAgent: false, record: false },
      container: { runtime: "docker", transport: "local" },
      updatedAt: 0,
    },
    connectionId: "conn-1",
  };
}

function session(overrides: Partial<ContainerSession> = {}): ContainerSession {
  return {
    connectionId: "conn-1",
    runtime: "docker",
    namespace: "default",
    containers: [
      { id: "c1", name: "web", image: "nginx", state: "running", status: "Up", ports: "", createdAt: "now" },
      { id: "c2", name: "db", image: "pg", state: "exited", status: "Exited", ports: "", createdAt: "now" },
    ],
    images: [
      { id: "i1", repository: "nginx", tag: "latest", size: "10MB", createdAt: "now" },
      { id: "i2", repository: "pg", tag: "16", size: "20MB", createdAt: "now" },
    ],
    namespaces: [],
    loading: false,
    refreshing: false,
    imagesLoading: false,
    error: null,
    info: null,
    tasks: [],
    ...overrides,
  };
}

/** Flushes the microtasks a stats sample and its render settle in. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function mount(withSession: ContainerSession = session(), active = true): Promise<void> {
  selectedStates = [];
  imagesShown = 0;
  const pinia = createPinia();
  setActivePinia(pinia);
  app = createApp({
    render: () =>
      h(DockerOverview, {
        tab: tab(),
        session: withSession,
        active,
        "onShow-state": (state: string) => selectedStates.push(state),
        "onShow-images": () => {
          imagesShown += 1;
        },
      }),
  });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await flush();
}

function summary(name: string): HTMLElement {
  const element = document.querySelector(`[data-docker-summary-${name}]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`the overview has no ${name} row`);
  }
  return element;
}

beforeEach(() => {
  statsMock.mockClear();
  statsMock.mockResolvedValue([]);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.useRealTimers();
});

describe("the summary rows", () => {
  it("counts what the engine holds, running and all", async () => {
    await mount();
    expect(summary("containers").textContent).toContain("2 in total");
    expect(summary("containers").textContent).toContain("1 running");
    expect(summary("images").textContent).toContain("2 in total");
    expect(summary("abnormal").textContent).toContain("0");
  });

  it("is the page it counts: a click jumps, and the abnormal row names its state", async () => {
    await mount();

    summary("containers").click();
    summary("images").click();
    summary("abnormal").click();
    await nextTick();

    expect(selectedStates).toEqual(["", "dead"]);
    expect(imagesShown).toBe(1);
  });

  it("takes its totals from the engine's own answer when it gave one", async () => {
    await mount(
      session({
        info: {
          runtime: "docker",
          cpus: 2,
          memory: 1024,
          containersTotal: 36,
          containersByState: [],
          imagesTotal: 14,
          imagesTagged: 10,
          imagesDangling: 4,
        },
      }),
    );
    expect(summary("containers").textContent).toContain("36 in total");
    expect(summary("images").textContent).toContain("14 in total");
  });
});

describe("the health lamp", () => {
  it("reads healthy while nothing is dead", async () => {
    await mount();
    const lamp = document.querySelector("[data-docker-overview-health]");
    expect(lamp?.querySelector("span")?.className).toContain("bg-success");
    expect(lamp?.textContent).toContain("running normally");
  });

  it("goes unhealthy when a container is dead", async () => {
    await mount(
      session({
        containers: [
          { id: "c1", name: "web", image: "nginx", state: "running", status: "Up", ports: "", createdAt: "now" },
          { id: "c3", name: "gone", image: "x", state: "dead", status: "Dead", ports: "", createdAt: "now" },
        ],
      }),
    );
    const lamp = document.querySelector("[data-docker-overview-health]");
    expect(lamp?.querySelector("span")?.className).toContain("bg-destructive");
    expect(lamp?.textContent).toContain("abnormal state");
  });
});

describe("the sampling", () => {
  function stat(
    cpuPercent: number,
    memoryPercent: number,
    networkInput: number,
    networkOutput: number,
  ): ContainerStats {
    return {
      id: "c1",
      name: "web",
      cpuPercent,
      memoryUsage: 0,
      memoryLimit: 0,
      memoryPercent,
      networkInput,
      networkOutput,
      blockInput: 0,
      blockOutput: 0,
      pids: 0,
    };
  }

  it("asks the engine once on mount, draws its line on the second sample, and says a too-young series honestly", async () => {
    statsMock.mockResolvedValue([stat(12.5, 40, 100, 50)]);
    vi.useFakeTimers();
    await mount();
    await nextTick();

    // One sample is not a line: a series too young to draw says so rather than drawing a dot.
    expect(document.querySelector("[data-docker-chart-cpu] polyline")).toBeNull();
    expect(document.querySelector("[data-docker-chart-cpu]")?.textContent).toContain("—");
    expect(statsMock).toHaveBeenCalledTimes(1);
    expect(statsMock).toHaveBeenCalledWith("conn-1");

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    await flush();
    await nextTick();
    expect(document.querySelector("[data-docker-chart-cpu] polyline")).not.toBeNull();
  });

  it("samples again every interval while the page is visible", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([]);
    await mount();
    expect(statsMock).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    await flush();
    expect(statsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps still while the document is hidden, and resumes when it is seen again", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([]);
    await mount();
    const seen = statsMock.mock.calls.length;

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3);
    await flush();
    expect(statsMock.mock.calls.length).toBe(seen);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(statsMock.mock.calls.length).toBeGreaterThan(seen);
  });

  it("stops while the window is not the one in front", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([]);
    await mount(session(), false);
    const seen = statsMock.mock.calls.length;

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS * 3);
    await flush();
    expect(statsMock.mock.calls.length).toBe(seen);
  });
});
