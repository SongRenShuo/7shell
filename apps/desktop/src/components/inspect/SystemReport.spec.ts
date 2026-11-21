/**
 * The system report, as the monitor window opens onto it: a band of readings under the host's
 * name, the two trend charts the store's buffers feed, and the share bars saying where the
 * processors' time went — with the static detail kept below the first screen.
 *
 * The three bodies are asserted as bodies: the skeleton stands only before anything has been
 * drawn, the unanswered state carries the retry that asks the host again, and the page itself
 * draws the readings it is handed. The tones are asserted where the desktops' one pair of cuts
 * decides them — the memory chart and the disk bars wear what `usageTone` names.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SystemReport from "@/components/inspect/SystemReport.vue";
import { i18n } from "@/i18n";
import { ShellError } from "@/lib/backend/errors";
import type { CpuShare } from "@/lib/monitor/rates";
import { useMonitorStore } from "@/stores/monitor";
import type { HostMetrics } from "@/types/monitor";

let app: App | undefined;
let host: HTMLDivElement | undefined;

/** Whether the page is the one on screen with a sample about its host. */
const live = ref(false);

async function mount(isLive = true): Promise<void> {
  live.value = isLive;
  const pinia = createPinia();
  setActivePinia(pinia);
  app = createApp({ render: () => h(SystemReport, { live: live.value }) });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** Puts one sample's worth of readings in the store, the way an answer would. */
function seedSample(overrides: Partial<HostMetrics> = {}): HostMetrics {
  const sample: HostMetrics = {
    sampledAt: 1_700_000_000_000,
    roundTripMs: 12,
    hostname: "web-1",
    os: "Ubuntu 24.04 LTS",
    kernel: "6.8.0-31-generic",
    arch: "x86_64",
    cores: 4,
    cpuModel: { name: "Intel(R) Core(TM) i9-14900HX", frequencyMhz: 2419.198, cacheKb: 36_864, bogomips: 4838.39 },
    uptimeSeconds: 90_061,
    load: { one: 0.21, five: 0.1, fifteen: 0.05 },
    cpu: {
      totalTicks: 1000,
      idleTicks: 800,
      states: {
        userTicks: 150,
        niceTicks: 0,
        systemTicks: 50,
        idleTicks: 800,
        ioWaitTicks: 0,
        interruptTicks: 0,
        softInterruptTicks: 0,
        stealTicks: 0,
      },
    },
    memory: {
      totalBytes: 8_000_000_000,
      availableBytes: 4_000_000_000,
      swapTotalBytes: 2_000_000_000,
      swapFreeBytes: 2_000_000_000,
    },
    network: [{ name: "eth0", receivedBytes: 1_000_000, transmittedBytes: 500_000 }],
    disks: [
      { filesystem: "/dev/sda1", mountPoint: "/", sizeBytes: 100_000_000_000, availableBytes: 40_000_000_000 },
      { filesystem: "/dev/sdb1", mountPoint: "/srv", sizeBytes: 100_000_000_000, availableBytes: 8_000_000_000 },
    ],
    processes: [],
  };
  return { ...sample, ...overrides };
}

/** Seeds the store the way a page on screen finds it after a few samples. */
function seedReadings(memoryHistory: number[] = [50, 48, 43]): void {
  const monitor = useMonitorStore();
  monitor.sample = seedSample();
  monitor.sampleSessionId = "session-1";
  monitor.cpuPercent = 12.5;
  monitor.cpuShares = shares();
  monitor.cpuHistory = [5, 12.5, 8];
  monitor.memoryHistory = memoryHistory;
}

/** The full breakdown, as the store holds it once two samples have been compared. */
function shares(): CpuShare[] {
  return [
    { state: "userTicks", percent: 30 },
    { state: "niceTicks", percent: 0.5 },
    { state: "systemTicks", percent: 10 },
    { state: "interruptTicks", percent: 1 },
    { state: "softInterruptTicks", percent: 2 },
    { state: "ioWaitTicks", percent: 4.5 },
    { state: "stealTicks", percent: 0 },
    { state: "idleTicks", percent: 52 },
  ];
}

/** The failure the store holds when a sample did not come back, as `asShellError` normalizes it. */
const failure = new ShellError({
  version: 1,
  code: "APP-INTERNAL",
  messageKey: "errors.app.internal",
  messageParams: {},
  origin: { subsystem: "app" },
  outcome: "unknown",
});

function report(part: string): HTMLElement {
  const found = document.querySelector(`[data-report-${part}]`);
  if (!(found instanceof HTMLElement)) {
    throw new Error(`the report has no ${part}: ${host?.textContent}`);
  }
  return found;
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the first screen", () => {
  it("opens on the band and the two charts, with the detail kept below", async () => {
    await mount(true);
    seedReadings();
    await nextTick();

    const band = report("band");
    expect(band.textContent).toContain("web-1");
    expect(band.textContent).toContain("Ubuntu 24.04 LTS");
    expect(
      band.querySelectorAll(
        "[data-report-tile-cpu], [data-report-tile-memory], [data-report-tile-swap], [data-report-tile-load], [data-report-tile-uptime]",
      ),
    ).toHaveLength(5);
    expect(report("tile-cpu").textContent).toContain("12.5%");
    expect(report("tile-memory").textContent).toContain("50.0%");

    const cpuChart = report("chart-cpu");
    const memoryChart = report("chart-memory");
    expect(cpuChart.querySelector("svg"), "the processor chart has readings to draw").not.toBeNull();
    expect(memoryChart.querySelector("svg"), "the memory chart has readings to draw").not.toBeNull();

    expect(report("share").querySelectorAll("li")).toHaveLength(8);
    expect(report("details").textContent).toContain("6.8.0-31-generic");

    expect(document.querySelector("[data-report-skeleton]")).toBeNull();
    expect(document.querySelector("[data-report-unanswered]")).toBeNull();
  });

  it.each([
    [43, "var(--success)"],
    [92, "var(--warning)"],
    [96, "var(--destructive)"],
  ] as const)("paints the memory chart in the tier its latest reading earns: %i%% wears %s", async (latest, token) => {
    await mount(true);
    seedReadings([50, latest]);
    await nextTick();

    const edge = report("chart-memory").querySelectorAll("path")[1];
    expect(edge?.getAttribute("stroke"), `a memory level of ${latest} wears ${token}`).toBe(token);
  });

  it("says a too-young chart honestly, with the dash the numbers use", async () => {
    await mount(true);
    seedReadings([50]);
    useMonitorStore().cpuHistory = [];
    await nextTick();

    const cpuChart = report("chart-cpu");
    expect(cpuChart.querySelector("svg")).toBeNull();
    expect(cpuChart.textContent).toContain("—");
  });

  it("draws each CPU column as one bar with its number, and a dash when nothing was measured", async () => {
    await mount(true);
    seedReadings();
    await nextTick();

    const rows = report("share").querySelectorAll("li");
    expect(rows, "one bar a column").toHaveLength(8);
    const first = rows[0];
    if (!first) {
      throw new Error("the share rows are not drawn");
    }
    expect(first.textContent).toContain("User");
    expect(first.textContent).toContain("30.0%");
    const fill = first.querySelector<HTMLElement>("span > span");
    expect(fill?.style.width, "the bar is as long as the share it stands for").toBe("30%");
    expect(fill?.getAttribute("style")).toContain("var(--workbench-accent)");

    useMonitorStore().cpuShares = null;
    await nextTick();
    expect(report("share").querySelectorAll("li")).toHaveLength(0);
    const paragraphs = [...report("share").querySelectorAll("p")];
    expect(paragraphs.at(-1)?.textContent, "the dash where a reading would be").toBe("-");
  });

  it("gives each file system a bar in the tier the desktops share", async () => {
    await mount(true);
    seedReadings();
    await nextTick();

    const rows = document.querySelectorAll('table[aria-label="File systems"] tbody tr');
    expect(rows).toHaveLength(2);
    const first = rows[0]?.querySelector<HTMLElement>("td .bg-muted > span");
    expect(first?.getAttribute("style"), "sixty per cent full wears the success token").toContain("var(--success)");
    const second = rows[1]?.querySelector<HTMLElement>("td .bg-muted > span");
    expect(second?.getAttribute("style"), "ninety-two wears the warning token").toContain("var(--warning)");
  });

  it("gauges the swap when there is one, and says so when there is not", async () => {
    await mount(true);
    seedReadings();
    await nextTick();

    expect(report("memory").querySelector("svg"), "an unused swap still has a ring").not.toBeNull();
    expect(report("memory").textContent).not.toContain("no swap space");

    useMonitorStore().sample = seedSample({
      memory: { totalBytes: 8_000_000_000, availableBytes: 4_000_000_000, swapTotalBytes: 0, swapFreeBytes: 0 },
    });
    await nextTick();

    expect(report("memory").querySelector("svg")).toBeNull();
    expect(report("memory").textContent).toContain("no swap space");
  });
});

describe("the three bodies", () => {
  it("stands a skeleton in the shape of the first screen until the first reading arrives", async () => {
    await mount(false);

    const skeleton = report("skeleton");
    expect(skeleton.querySelectorAll(".skeleton").length).toBeGreaterThan(0);
    expect(document.querySelector("[data-report-band]")).toBeNull();
    expect(document.querySelector("[data-report-unanswered]")).toBeNull();
  });

  it("never goes back to the skeleton once a reading has been drawn", async () => {
    await mount(false);
    expect(document.querySelector("[data-report-skeleton]")).not.toBeNull();

    seedReadings();
    live.value = true;
    await nextTick();
    expect(document.querySelector("[data-report-band]"), "the reading is drawn").not.toBeNull();

    live.value = false;
    await nextTick();

    const unanswered = document.querySelector("[data-report-unanswered]");
    expect(unanswered, "the silence is the empty state's to explain").not.toBeNull();
    expect(document.querySelector("[data-report-skeleton]")).toBeNull();
    expect(unanswered?.querySelector("[data-report-retry]")).not.toBeNull();
  });

  it("answers a failure before the first reading with the way out, not a skeleton", async () => {
    await mount(false);
    const monitor = useMonitorStore();
    const retry = vi.spyOn(monitor, "retry");
    monitor.failure = failure;
    await nextTick();

    const unanswered = report("unanswered");
    expect(unanswered.textContent).toContain("The host has not sent a reading yet.");
    const button = unanswered.querySelector<HTMLElement>("[data-report-retry]");
    if (!button) {
      throw new Error("the empty state offers no way out");
    }
    expect(button.textContent).toContain("Retry");

    button.click();
    await nextTick();
    expect(retry, "the retry asks the store for a sample").toHaveBeenCalledTimes(1);
  });
});
