/**
 * The desktop overview, as a person reads it: what the engine holds in three pressable tiles (the
 * third wearing the health verdict the page's lamp used to say), and the three short lines drawn
 * from what the engine reported, each titled with its newest reading.
 *
 * The tiles and the readings are DOM facts; the sampling is asserted through the backend mock —
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
      terminal: {
        terminalType: "xterm-256color",
        keepaliveSeconds: 0,
        encoding: "utf-8",
        backspace: "del",
        forwardAgent: false,
        record: false,
      },
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
    eventsStreamId: null,
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
    throw new Error(`the overview has no ${name} tile`);
  }
  return element;
}

/** A tile reads as its label above the big number; the last paragraph is the number. */
function tileParts(name: string): { label: string; value: string } {
  const paragraphs = [...summary(name).querySelectorAll("p")];
  if (paragraphs.length < 2) {
    throw new Error(`the ${name} tile is not drawn`);
  }
  return {
    label: paragraphs[0]?.textContent?.trim() ?? "",
    value: paragraphs[paragraphs.length - 1]?.textContent?.trim() ?? "",
  };
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

describe("the summary tiles", () => {
  it("counts what the engine holds, running and all, at a glance", async () => {
    await mount();
    expect(tileParts("containers").label).toContain("1 running");
    expect(tileParts("containers").value).toBe("2");
    expect(tileParts("images").value).toBe("2");
    expect(tileParts("abnormal").value).toBe("0");
  });

  it("is the page it counts: a click jumps, and the health tile names its state", async () => {
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
    expect(tileParts("containers").value).toBe("36");
    expect(tileParts("images").value).toBe("14");
  });
});

describe("the engine tile, which carries the lamp the rows used to sit beside", () => {
  it("reads healthy while nothing is dead: a calm number and the sentence on its tooltip", async () => {
    await mount();
    const tile = summary("abnormal");
    expect(tileParts("abnormal").value).toBe("0");
    expect(tile.getAttribute("title")).toContain("running normally");
    expect(tile.querySelector("p.nums")?.getAttribute("style"), "a healthy engine wears no tier").toBeNull();
  });

  it("goes red when a container is dead, and says the sentence out loud", async () => {
    await mount(
      session({
        containers: [
          { id: "c1", name: "web", image: "nginx", state: "running", status: "Up", ports: "", createdAt: "now" },
          { id: "c3", name: "gone", image: "x", state: "dead", status: "Dead", ports: "", createdAt: "now" },
        ],
      }),
    );
    const tile = summary("abnormal");
    expect(tileParts("abnormal").value).toBe("1");
    expect(tile.getAttribute("title")).toContain("abnormal state");
    expect(tile.querySelector("p.nums")?.getAttribute("style")).toContain("var(--destructive)");
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

  it("asks the engine once on mount, draws its band on the second sample, and says a too-young series honestly", async () => {
    statsMock.mockResolvedValue([stat(12.5, 40, 100, 50)]);
    vi.useFakeTimers();
    await mount();
    await nextTick();

    // One sample is not an area: a series too young to draw says so rather than drawing a dot.
    expect(document.querySelector("[data-docker-chart-cpu] svg")).toBeNull();
    expect(document.querySelector("[data-docker-chart-cpu]")?.textContent).toContain("—");
    expect(statsMock).toHaveBeenCalledTimes(1);
    expect(statsMock).toHaveBeenCalledWith("conn-1");

    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    await flush();
    await nextTick();
    expect(document.querySelector("[data-docker-chart-cpu] path")).not.toBeNull();
  });

  it("titles each chart with its newest reading, unit and all — the network's is a rate", async () => {
    statsMock.mockResolvedValue([stat(12.5, 40, 100, 50)]);
    vi.useFakeTimers();
    await mount();
    await nextTick();

    expect(document.querySelector("[data-docker-chart-cpu]")?.textContent).toContain("12.5%");
    expect(document.querySelector("[data-docker-chart-memory]")?.textContent).toContain("40.0%");
    expect(document.querySelector("[data-docker-chart-network]")?.textContent).toContain("/s");

    // Two samples make the rate real: 150 bytes moved over the five-second interval.
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    await flush();
    await nextTick();
    const network = document.querySelector("[data-docker-chart-network]")?.textContent ?? "";
    expect(network).toContain("/s");
    expect(network, "a rate, not the counter").not.toContain("150");
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

  it.each([
    [40, "var(--success)"],
    [92, "var(--warning)"],
    [96, "var(--destructive)"],
  ] as const)("paints the memory line in the tier the desktops share: %i%% wears %s", async (memoryPercent, token) => {
    statsMock.mockResolvedValue([stat(12.5, memoryPercent, 100, 50)]);
    vi.useFakeTimers();
    await mount();
    vi.advanceTimersByTime(SAMPLE_INTERVAL_MS);
    await flush();
    await nextTick();

    const edge = document.querySelector("[data-docker-chart-memory]")?.querySelectorAll("path")[1];
    expect(edge?.getAttribute("stroke"), `the reading at ${memoryPercent} wears ${token}`).toBe(token);
  });
});
