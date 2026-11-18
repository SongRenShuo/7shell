/**
 * The widgets column, as the desk draws it: the four cards the machine's vitals land on, the
 * thresholds a full storage wears, and the sampling rule that makes the column cheap — nobody
 * watching, no sampling.
 *
 * The rates are worth pinning here because they are the part a reader can get silently wrong: CPU
 * and network need two samples a known distance apart, and a rate invented from one sample would
 * always render, and always be about nothing.
 */
import { type App, createApp, defineComponent, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkbenchWidgets from "@/components/workspace/WorkbenchWidgets.vue";
import { backend } from "@/lib/backend/api";
import type { WorkbenchWidgetId } from "@/lib/workbench/desktopWidgets";
import { i18n } from "@/i18n";
import type { HostMetrics } from "@/types/monitor";

vi.mock("@/lib/backend/api", () => ({
  backend: {
    monitor: {
      sample: vi.fn(),
    },
  },
}));

const sampleMock = vi.mocked(backend.monitor.sample);

/** A metrics shape with only what the widgets read; everything else stays away, as hosts do. */
function metrics(overrides: Partial<HostMetrics> = {}): HostMetrics {
  return {
    sampledAt: Date.now(),
    roundTripMs: 12,
    hostname: "nas-server",
    os: "Linux",
    kernel: "6.1",
    arch: "x86_64",
    cores: 4,
    cpuModel: null,
    uptimeSeconds: 90061,
    load: { one: 0.4, five: 0.8, fifteen: 1.1 },
    cpu: { totalTicks: 10_000, idleTicks: 8_000, states: {} as never },
    memory: { totalBytes: 8, availableBytes: 4, swapTotalBytes: 0, swapFreeBytes: 0 },
    network: [{ name: "eth0", receivedBytes: 1_000, transmittedBytes: 500 }],
    disks: [{ mountPoint: "/", filesystem: "ext4", sizeBytes: 100, availableBytes: 10 }],
    processes: [],
    ...overrides,
  };
}

let app: App | undefined;
let root: HTMLDivElement | undefined;
let opened: Array<"monitor" | "system">;

function mount(props: { handle: string | null; active: boolean; enabled?: WorkbenchWidgetId[] }): void {
  opened = [];
  const Host = defineComponent({
    setup() {
      return () =>
        h(WorkbenchWidgets, {
          handle: props.handle,
          active: props.active,
          enabled: props.enabled ?? ["system", "cpu", "net", "storage"],
          onOpen: (target: "monitor" | "system") => {
            opened.push(target);
          },
        });
    },
  });
  app = createApp(Host);
  app.use(i18n);
  root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
}

beforeEach(() => {
  vi.useFakeTimers();
  sampleMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  app?.unmount();
  app = undefined;
  root?.remove();
  root = undefined;
  document.body.innerHTML = "";
});

function cards(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-widget-id]")];
}

function card(id: string): HTMLElement {
  const found = cards().find((entry) => entry.dataset.widgetId === id);
  if (found === undefined) {
    throw new Error(`the column has no ${id} widget`);
  }
  return found;
}

describe("the widgets column", () => {
  it("draws one card per enabled widget, and none when all are turned off", () => {
    mount({ handle: "h1", active: true });
    expect(cards().map((card) => card.dataset.widgetId)).toEqual(["system", "cpu", "net", "storage"]);

    app?.unmount();
    mount({ handle: "h1", active: true, enabled: [] });
    expect(document.querySelector("[data-workbench-widgets]"), "an empty set draws no column").toBeNull();
  });

  it("samples the machine and fills the level readings", async () => {
    sampleMock.mockResolvedValue(metrics());
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(sampleMock).toHaveBeenCalledWith("h1");
    expect(card("system").textContent).toContain("nas-server");
    expect(card("system").textContent).toContain("1d 1h");
    expect(card("cpu").textContent).toContain("4");
  });

  it("says a rate only once two samples a known distance apart exist", async () => {
    sampleMock.mockResolvedValue(metrics({ sampledAt: 1_000 }));
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(card("net").textContent).toContain("—");

    sampleMock.mockResolvedValue(
      metrics({
        sampledAt: 3_000,
        // 1000 ticks forward, 800 of them idle: a 20% busy interval.
        cpu: { totalTicks: 11_000, idleTicks: 8_800, states: {} as never },
        network: [{ name: "eth0", receivedBytes: 3_000, transmittedBytes: 1_500 }],
      }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();

    // (3000 - 1000) bytes over 2 seconds, each way — said in the formatter's units.
    expect(card("net").textContent).toContain("1.0 KB/s");
    expect(card("net").textContent).toContain("500 B/s");
    expect(card("cpu").textContent).toContain("20%");
  });

  it("wears the threshold colours on storage: amber at 90-95, red past 95", async () => {
    sampleMock.mockResolvedValue(metrics());
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // (100 - 10) / 100 = 90%: the amber band.
    expect(card("storage").querySelector(".is-warn"), "90% wears amber").not.toBeNull();

    sampleMock.mockResolvedValue(
      metrics({ disks: [{ mountPoint: "/", filesystem: "ext4", sizeBytes: 100, availableBytes: 3 }] }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();

    expect(card("storage").querySelector(".is-danger"), "97% wears red").not.toBeNull();
    expect(card("storage").textContent).toContain("97%");
  });

  it("opens the window that can explain the pressed card", async () => {
    sampleMock.mockResolvedValue(metrics());
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    card("cpu").click();
    card("storage").click();

    expect(opened).toEqual(["monitor", "system"]);
  });

  it("stops sampling when the desktop stops being the tab on screen, and resumes when it returns", async () => {
    sampleMock.mockResolvedValue(metrics());
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sampleMock).toHaveBeenCalledTimes(1);

    const host = defineComponent({ template: "<div />" });
    void host;
    // The pane flips the prop; the pump stops without a stray tick behind it. The first mount's
    // one sample is already counted, so the ledger starts clean for the unseen desktop.
    sampleMock.mockClear();
    app?.unmount();
    root?.remove();
    document.body.innerHTML = "";
    mount({ handle: "h1", active: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await nextTick();
    expect(sampleMock, "an unseen desktop reads nothing").toHaveBeenCalledTimes(0);
  });

  it("does not pump at all while the application window is hidden", async () => {
    document.visibilityState;
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    try {
      mount({ handle: "h1", active: true });
      await vi.advanceTimersByTimeAsync(10_000);
      await nextTick();
      expect(sampleMock, "a hidden application reads nothing").toHaveBeenCalledTimes(0);
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });
});
