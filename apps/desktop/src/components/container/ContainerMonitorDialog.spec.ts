/**
 * The monitor dialog, as a person meets it: the first reading arrives and the three lines appear
 * (each titled with the row's newest number), a second reading turns into a rate rather than a
 * total, only the row it was opened for is drawn, and a closed dialog asks the engine nothing.
 *
 * The sampling discipline itself (in front and visible) is the overview's, whose suite already
 * pins it; what can only be seen here is the per-container cut and the dialog's own lifecycle.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const statsMock = vi.fn();

vi.mock("@/lib/backend/api", () => ({
  backend: { containers: { stats: (connectionId: string) => statsMock(connectionId) } },
}));

import ContainerMonitorDialog from "@/components/container/ContainerMonitorDialog.vue";
import { i18n } from "@/i18n";
import type { ContainerSession } from "@/stores/container";
import type { ContainerStats, ContainerSummary } from "@/types/container";

const SESSION = { connectionId: "conn-1" } as ContainerSession;
const TARGET = { id: "aaa", name: "web", state: "running" } as ContainerSummary;

function stats(overrides: Partial<ContainerStats> = {}): ContainerStats {
  return {
    id: "aaa",
    name: "web",
    cpuPercent: 12.5,
    memoryUsage: 1024,
    memoryLimit: 2048,
    memoryPercent: 50,
    networkInput: 100,
    networkOutput: 100,
    blockInput: 0,
    blockOutput: 0,
    pids: 3,
    ...overrides,
  };
}

let host: HTMLDivElement;
let app: App | undefined;

beforeEach(() => {
  statsMock.mockReset();
  statsMock.mockResolvedValue([stats()]);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  document.body.innerHTML = "";
  vi.useRealTimers();
});

async function render(open = true, active = true, target: ContainerSummary | null = TARGET): Promise<void> {
  app = createApp({
    render: () =>
      h(ContainerMonitorDialog, {
        open,
        session: SESSION,
        target,
        active,
        onClose: () => {},
      }),
  }).use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
  await nextTick();
}

describe("the container monitor", () => {
  it("leaves the waiting sentence behind on the first reading, and draws lines once there are two", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([stats()]);
    await render();

    // The first reading answers the waiting sentence; one point is not yet a band.
    expect(document.querySelector("[data-container-monitor-waiting]")).toBeNull();
    expect(document.querySelector("[data-container-monitor-cpu] svg")).toBeNull();

    await vi.advanceTimersByTimeAsync(5000);
    await nextTick();

    expect(document.querySelector("[data-container-monitor-cpu] path")).not.toBeNull();
    expect(document.querySelector("[data-container-monitor-memory] path")).not.toBeNull();
    expect(document.querySelector("[data-container-monitor-network] path")).not.toBeNull();
  });

  it("draws the row it was opened for, out of the engine-wide answer", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([
      stats({ id: "other", name: "db", cpuPercent: 99 }),
      stats({ id: "aaa", name: "web", cpuPercent: 5 }),
    ]);
    await render();

    await vi.advanceTimersByTimeAsync(5000);
    await nextTick();

    expect(document.querySelector("[data-container-monitor-cpu] path")).not.toBeNull();
    expect(statsMock).toHaveBeenCalledWith("conn-1");
  });

  it("draws nothing at all while it is closed, and asks the engine nothing", async () => {
    await render(false);

    expect(document.querySelector("[data-container-monitor]")).toBeNull();
    expect(statsMock).not.toHaveBeenCalled();
  });

  it("turns two readings into a rate, not a running total", async () => {
    vi.useFakeTimers();
    statsMock
      .mockResolvedValueOnce([stats({ networkInput: 1000, networkOutput: 0 })])
      .mockResolvedValueOnce([stats({ networkInput: 6000, networkOutput: 0 })]);
    await render();

    // Five seconds later the counter stands at 6000: 5000 bytes over 5s is 1000/s.
    await vi.advanceTimersByTimeAsync(5000);
    await nextTick();

    const network = document.querySelector("[data-container-monitor-network]");
    expect(network?.textContent).toContain("/s");
    expect(network?.textContent, "a rate, not the counter").not.toContain("6000");
  });

  it("titles each chart with the row's newest reading, the overview's own visual", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([stats({ cpuPercent: 12.5, memoryPercent: 50 })]);
    await render();

    expect(document.querySelector("[data-container-monitor-cpu]")?.textContent).toContain("12.5%");
    expect(document.querySelector("[data-container-monitor-memory]")?.textContent).toContain("50.0%");
    expect(document.querySelector("[data-container-monitor-network]")?.textContent).toContain("/s");
  });

  it("draws only the row it was opened for: another container's numbers stay off the titles", async () => {
    vi.useFakeTimers();
    statsMock.mockResolvedValue([
      stats({ id: "other", name: "db", cpuPercent: 99, memoryPercent: 88 }),
      stats({ cpuPercent: 12.5, memoryPercent: 50 }),
    ]);
    await render();
    await nextTick();

    const cpu = document.querySelector("[data-container-monitor-cpu]")?.textContent ?? "";
    expect(cpu, "the opened row's reading, not the loudest row of the answer").toContain("12.5%");
    expect(cpu).not.toContain("99%");
  });
});
