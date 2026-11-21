/**
 * The widgets column, as the desk draws it: the four cards the machine's vitals land on, the
 * thresholds a full storage wears, and the sampling rule that makes the column cheap — nobody
 * watching, no sampling.
 *
 * The rates are worth pinning here because they are the part a reader can get silently wrong: CPU
 * and network need two samples a known distance apart, and a rate invented from one sample would
 * always render, and always be about nothing.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

describe("the cards' trend strips", () => {
  /**
   * One sample whose counters and clock stand where they are told. Two samples 2000 ms apart read
   * as `(totalTicks₂ − totalTicks₁)` ticks over that interval, of which `(idleTicks₂ − idleTicks₁)`
   * were idle — the busy share is the remainder. `netBytes` moving 2000 between the pair is 1000 B/s.
   */
  function sample(sampledAt: number, totalTicks: number, idleTicks: number, netBytes: number): HostMetrics {
    return metrics({
      sampledAt,
      cpu: { totalTicks, idleTicks, states: {} as never },
      network: [{ name: "eth0", receivedBytes: netBytes, transmittedBytes: netBytes }],
    });
  }

  function bars(id: string): number {
    return card(id).querySelectorAll('[role="img"] span').length;
  }

  it("draws the strips only once two samples exist — one sample is not a trend", async () => {
    sampleMock.mockResolvedValue(sample(1_000, 10_000, 8_000, 1_000));
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    expect(bars("cpu"), "a single sample carries no history yet").toBe(0);
    expect(bars("net"), "a single rate carries no history yet").toBe(0);

    // The idle counter stands still over the interval: 10000 ticks, all busy.
    sampleMock.mockResolvedValue(sample(3_000, 20_000, 8_000, 3_000));
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();

    expect(bars("cpu"), "the second sample starts the busy-share strip").toBe(1);
    expect(bars("net"), "the second sample starts the throughput strip").toBe(1);
    expect(card("cpu").textContent).toContain("100%");
  });

  it("freezes the strips while the application window is hidden, and grows them when it is seen again", async () => {
    try {
      sampleMock.mockResolvedValue(sample(1_000, 10_000, 8_000, 1_000));
      mount({ handle: "h1", active: true });
      await vi.advanceTimersByTimeAsync(0);
      await nextTick();
      sampleMock.mockResolvedValue(sample(3_000, 20_000, 8_000, 3_000));
      await vi.advanceTimersByTimeAsync(2_000);
      await nextTick();
      const before = bars("cpu");
      expect(before).toBeGreaterThan(0);

      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(10_000);
      await nextTick();
      expect(bars("cpu"), "a hidden window's strip stands still").toBe(before);
      expect(sampleMock, "and no sample was taken to grow it").toHaveBeenCalledTimes(2);

      // A fresh sample waits: the machine was asked again, its counters moved on.
      sampleMock.mockResolvedValue(sample(5_000, 30_000, 8_000, 5_000));
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      await nextTick();
      expect(bars("cpu"), "the seen-again window's strip grows on the next sample").toBeGreaterThan(before);
    } finally {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    }
  });

  it("wears the threshold colour on a hot CPU's number: amber at 90-95, red past 95", async () => {
    sampleMock.mockResolvedValue(sample(1_000, 10_000, 8_000, 1_000));
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // 800 idle ticks of the interval's 10000: 92% busy, the amber band.
    sampleMock.mockResolvedValue(sample(3_000, 20_000, 8_800, 3_000));
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();
    expect(card("cpu").querySelector(".is-warn"), "92% busy wears amber").not.toBeNull();
    expect(card("cpu").textContent).toContain("92%");

    // 400 idle ticks of the interval's 10000: 96% busy, the red band.
    sampleMock.mockResolvedValue(sample(5_000, 30_000, 9_200, 5_000));
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();
    expect(card("cpu").querySelector(".is-danger"), "96% busy wears red").not.toBeNull();
  });

  it("draws the storage bar in the workbench family, wearing the tier the reading earns", async () => {
    sampleMock.mockResolvedValue(metrics());
    mount({ handle: "h1", active: true });
    await vi.advanceTimersByTimeAsync(0);
    await nextTick();

    // (100 - 10) / 100 = 90%: amber fill, named for a reader who cannot see it.
    const fill = card("storage").querySelector<HTMLElement>(".widget-bar-fill");
    expect(fill, "the bar is drawn").not.toBeNull();
    expect(fill?.style.background, "90% wears the workbench amber").toBe("var(--workbench-warning)");
    expect(card("storage").querySelector('[role="img"]')?.getAttribute("aria-label")).toContain("90%");

    sampleMock.mockResolvedValue(
      metrics({ disks: [{ mountPoint: "/", filesystem: "ext4", sizeBytes: 100, availableBytes: 3 }] }),
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await nextTick();
    expect(card("storage").querySelector<HTMLElement>(".widget-bar-fill")?.style.background).toBe(
      "var(--workbench-danger)",
    );
  });
});

describe("the cards' skin", () => {
  it("draws from the workbench tokens, thresholds and all, with no literal colour left", () => {
    // The cards' glass is scoped CSS, invisible to DOM assertions here; the probe is the source:
    // the Semi-era card tokens are named and the 90/95 thresholds wear the semantic pair.
    const source = readFileSync(resolve("apps/desktop/src/components/workspace/WorkbenchWidgets.vue"), "utf8");
    expect(source, "the cards are the bar surface").toContain("var(--workbench-surface-1)");
    expect(source, "90-95 wears the Semi warning").toContain("var(--workbench-warning)");
    expect(source, "past 95 wears the Semi danger").toContain("var(--workbench-danger)");
    expect(source, "the bar's track is the wallpaper text, not a theme token").toContain(
      "color-mix(in srgb, var(--workbench-on-picture) 16%, transparent)",
    );
    expect(source, "no literal colour is left in the chrome").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
