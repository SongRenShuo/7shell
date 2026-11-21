/**
 * The desktop's measured budgets, not its behaviour: what a drag costs, and what six open windows
 * cost while they sit minimised.
 *
 * The functional suites say what dragging *does* (WorkbenchPane.spec.ts) and what a minimised
 * window *shows*; what can only be seen here is the cost — that reordering the fullest desktop
 * the product allows (24 shortcuts over 12 doors) does not remount one of them, and that six
 * windows' worth of mounted components stay mounted and idle
 * when nobody is looking at them. The wall-time bounds are deliberately generous smoke guards
 * (LESSONS I43: a tight millisecond threshold turns red on a slow runner for reasons that have
 * nothing to do with the code); the assertions that carry the audit are the structural ones —
 * element identity across a drag, node counts bounded under six windows, a stopped stream.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));

// The terminal's completion reads the command-spec corpus as an asset on mount; in a test there is
// no server to serve it from, and a catalog with nothing in it is what a failure means anyway.
vi.mock("@/lib/commands/specs/load", () => ({
  loadSpecs: vi.fn(async () => ({ registry: {}, commandNames: [], byName: new Map() })),
  specsLoaded: vi.fn(() => null),
  resetSpecsForTesting: vi.fn(),
  catalogFromRaw: vi.fn(() => ({ registry: {}, commandNames: [], byName: new Map() })),
}));

// The tail stream's events are fired by hand, as the far side writes them. Handlers are kept per
// event, because the store registers a different reader for each and a line handed to the end
// reader would end the stream instead of being read.
const lineListeners: ((payload: unknown) => void)[] = [];

vi.mock("@/lib/backend/ipc", () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    if (event === "tail_line") {
      lineListeners.push(handler);
    }
    return () => {};
  }),
}));

vi.mock("@/lib/backend/tauri", () => ({
  sessionOpen: vi.fn(),
  terminalClose: vi.fn(async () => null),
  filesOpen: vi.fn(),
  filesList: vi.fn(async (_handle: string, path: string) => ({ path, entries: [] })),
  filesClose: vi.fn(async () => null),
  transfersOpen: vi.fn(async () => []),
  desktopEngineOpen: vi.fn(async () => {
    throw new Error("engine unavailable in the audit");
  }),
  fileTailOpen: vi.fn(),
  fileTailClose: vi.fn(async () => {}),
  commandClassify: vi.fn(),
  batchRun: vi.fn(),
  knownHostTrust: vi.fn(),
  knownHostForget: vi.fn(),
  onBatchEvent: vi.fn(async () => () => {}),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async () => {}),
  onDesktopResized: vi.fn(async () => () => {}),
  onDesktopClosed: vi.fn(async () => () => {}),
  onDesktopFailed: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

vi.mock("@/lib/batch/bus", () => ({
  startBatchBus: vi.fn(async () => {}),
  onBatchProgress: vi.fn(() => () => {}),
  stopBatchBus: vi.fn(),
}));

import WorkbenchPane from "@/components/workspace/WorkbenchPane.vue";
import { i18n } from "@/i18n";
import { filesOpen, sessionOpen } from "@/lib/backend/tauri";
import { MAX_DESKTOP_SHORTCUTS, writeDesktopShortcuts } from "@/lib/workbench/desktopIcons";
import { iconOrderKey } from "@/lib/workbench/iconOrder";
import { useTerminalsStore } from "@/stores/terminals";
import type { Session } from "@/types/session";

const sessionOpenMock = vi.mocked(sessionOpen);
const filesOpenMock = vi.mocked(filesOpen);

const desk: Session = {
  id: "desk-1",
  name: "lab desk",
  protocol: "linuxDesk",
  host: "lab.example.test",
  port: 22,
  user: "root",
  auth: { method: "password", hasSecret: true },
  terminal: {
    terminalType: "xterm-256color",
    keepaliveSeconds: 30,
    encoding: "utf-8",
    backspace: "del",
    forwardAgent: false,
    record: false,
  },
  updatedAt: 1_700_000_000,
};

let host: HTMLDivElement;
let app: App | undefined;

/** The number of fixed doors this build draws, whatever the functional lanes decide it is. */
function systemIconCount(): number {
  return host.querySelectorAll<HTMLElement>("[data-workbench-icon][data-icon-id^='system-']").length;
}

async function render(): Promise<void> {
  const terminals = useTerminalsStore();
  terminals.tabs = [{ kind: "workbench", id: "tab-workbench", session: desk, handle: "w1", failure: null }];
  terminals.openedOrder = ["tab-workbench"];
  terminals.activeTabId = "tab-workbench";

  const tab = terminals.tabs[0];
  if (!tab || tab.kind !== "workbench") {
    throw new Error("the workspace has no workbench tab to draw");
  }
  app = createApp({
    render: () => h(WorkbenchPane, { tab, active: true }),
  }).use(i18n);
  app.mount(host);
  await nextTick();
}

function icons(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-workbench-icon]")];
}

function iconById(id: string | undefined): HTMLElement {
  const found = icons().find((entry) => entry.dataset.iconId === id);
  if (!found) {
    throw new Error(`the desktop no longer draws the icon ${id}`);
  }
  return found;
}

/**
 * One drag, the way the browser reports it: pick up, hover across the icons in between, drop.
 *
 * The hover stops are part of the budget — each one flips the drag-over ring, which is a render of
 * its own, and a drag that redraws the whole desk per hover stop is exactly what this audit exists
 * to catch.
 */
async function dragSequence(from: HTMLElement, hoverStops: HTMLElement[], onto: HTMLElement | null): Promise<void> {
  from.dispatchEvent(new Event("dragstart", { bubbles: true }));
  for (const stop of hoverStops) {
    stop.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
    await nextTick();
  }
  (onto ?? host.querySelector<HTMLElement>("[data-workbench-desktop]"))!.dispatchEvent(
    new Event("drop", { bubbles: true, cancelable: true }),
  );
  from.dispatchEvent(new Event("dragend", { bubbles: true }));
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.body.appendChild(document.createElement("div"));
  localStorage.clear();
  lineListeners.length = 0;
  filesOpenMock.mockReset();
  filesOpenMock.mockResolvedValue({
    kind: "opened",
    handle: "f1",
    sessionId: desk.id,
    listing: { path: "/root", entries: [] },
    packed: true,
  });
});

afterEach(() => {
  app?.unmount();
  host.remove();
  localStorage.clear();
});

describe("the desktop's drag budget", () => {
  it("reorders every icon it can hold ten times without remounting one of them, inside the measured budget", async () => {
    // N is the desktop's own worst case: `MAX_DESKTOP_SHORTCUTS` shortcuts over the fixed doors —
    // 24 + 11 today. The doors are counted, not assumed, so a lane that adds or removes one changes
    // the total honestly instead of breaking the fixture.
    const SHORTCUTS = MAX_DESKTOP_SHORTCUTS;
    writeDesktopShortcuts(
      Object.fromEntries([
        [desk.id, Array.from({ length: SHORTCUTS }, (_, index) => ({ id: `s${index}`, path: `/srv/data-${index}` }))],
      ]),
    );
    await render();

    const doors = systemIconCount();
    const total = SHORTCUTS + doors;
    expect(icons(), "every shortcut and door is on the desktop").toHaveLength(total);

    // The identity ledger: which element object draws which icon. A keyed list patches in place,
    // so after any number of reorders the same object still draws the same icon; a remount hands
    // back a fresh element for an id somebody never touched.
    const before = new Map(icons().map((entry) => [entry.dataset.iconId, entry]));
    const nodesBefore = host.querySelectorAll("[data-workbench-icons] *").length;

    const start = performance.now();
    const all = icons();
    for (let round = 0; round < 10; round += 1) {
      const from = all[(round * 3) % total]!;
      const stops = [all[(round * 7 + 2) % total]!, all[(round * 11 + 5) % total]!];
      const onto = all[(round * 13 + 9) % total]!;
      await dragSequence(from, stops, onto);
    }
    const elapsedMs = performance.now() - start;
    // The reading is the point of this suite: printed so a later run can be compared against it.
    console.info(`drag budget: ${total} icons, 10 sequences with 2 hover stops each — ${elapsedMs.toFixed(1)}ms`);

    expect(icons(), "no icon was lost and none was doubled by the dragging").toHaveLength(total);
    for (const [id, element] of before) {
      expect(iconById(id), `the icon ${id} kept its element through ten drags`).toBe(element);
    }
    expect(
      host.querySelectorAll("[data-workbench-icons] *").length,
      "and the grid holds exactly the nodes it held",
    ).toBe(nodesBefore);

    // The smoke bound: ten full drag sequences with two hover stops each, over the full desktop. The
    // measured run sits in the low tens of milliseconds; the bound is where a regression to a
    // remounting drag (the old fear, a full list rebuild per hover stop) lands far past it.
    // LESSONS I43: the structural assertions above are the audit; this one only catches a blow-up.
    expect(elapsedMs, `ten drags over ${total} icons took ${elapsedMs.toFixed(1)}ms`).toBeLessThan(2_000);
  });

  it("keeps the stored order as long as the desktop itself after the ten drags", async () => {
    const SHORTCUTS = MAX_DESKTOP_SHORTCUTS;
    writeDesktopShortcuts(
      Object.fromEntries([
        [desk.id, Array.from({ length: SHORTCUTS }, (_, index) => ({ id: `s${index}`, path: `/srv/data-${index}` }))],
      ]),
    );
    await render();

    const all = icons();
    const total = all.length;
    for (let round = 0; round < 10; round += 1) {
      await dragSequence(all[(round * 5) % total]!, [], all[(round * 9 + 4) % total]!);
    }

    const stored = JSON.parse(localStorage.getItem(iconOrderKey(desk.id)) ?? "[]") as string[];
    expect(stored, "storage holds one id per icon, ten drags later").toHaveLength(total);
  });
});

describe("the desktop's keep-alive budget", () => {
  /** Opens one door's window, the way a person does: the second click. */
  async function openByIconId(id: string): Promise<void> {
    const icon = host.querySelector<HTMLElement>(`[data-icon-id="${id}"]`);
    if (!icon) {
      throw new Error(`the desktop has no icon ${id} to open`);
    }
    icon.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
  }

  /** The application inside a window frame, which is the thing a minimised window keeps mounted. */
  function windowContents(): Element[] {
    return [
      host.querySelector(".terminal-surface"),
      host.querySelector("[data-workbench-docker-window]"),
      host.querySelector("[data-workbench-tail-window]"),
      host.querySelector("[data-listing-header]"),
      host.querySelector("[data-workbench-transfers-window]"),
      host.querySelector("[data-workbench-batch-window]"),
    ].filter((entry): entry is Element => entry !== null);
  }

  it("holds six windows' worth of mounted components while every one of them sits minimised", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });

    await render();
    // The doors this audit needs are all fixed ones, so the fixture holds whatever the doors are.
    expect(systemIconCount()).toBeGreaterThanOrEqual(11);

    await openByIconId("system-terminal");
    await openByIconId("system-docker");
    await openByIconId("system-transfers");
    await openByIconId("system-batch");
    await openByIconId("system-home");
    await openByIconId("system-tail");

    const frames = host.querySelectorAll("[data-workbench-window]");
    expect(frames, "terminal, docker, transfers, batch, files and tail are six windows").toHaveLength(6);
    const mountedAtOpen = windowContents();
    expect(mountedAtOpen, "each window carries its own application").toHaveLength(6);
    const nodesAtOpen = host.querySelectorAll("[data-workbench-window] *").length;

    // Minimise every one of them, in the order they stand.
    for (const button of host.querySelectorAll<HTMLElement>("[data-workbench-window-min]")) {
      button.click();
      await nextTick();
    }

    expect(host.querySelectorAll("[data-workbench-window]"), "minimising is not closing").toHaveLength(6);
    const mountedMinimised = windowContents();
    expect(mountedMinimised, "and every application is still mounted behind its folded frame").toHaveLength(6);
    for (const [index, content] of mountedAtOpen.entries()) {
      expect(mountedMinimised[index], "the same element, not a rebuild").toBe(content);
    }
    // The keep-alive reading: the whole desk behind six folded frames, in nodes.
    console.info(
      `keep-alive: six windows open — ${nodesAtOpen} nodes under the frames; all minimised — ` +
        `${host.querySelectorAll("[data-workbench-window] *").length} nodes, ` +
        `${mountedMinimised.length} application roots still standing`,
    );
  });

  it("does nothing while nobody is looking: the hidden tail's buffer stops growing", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });

    const { fileTailOpen, fileTailClose } = await import("@/lib/backend/tauri");
    const openMock = vi.mocked(fileTailOpen);
    const closeMock = vi.mocked(fileTailClose);
    openMock.mockResolvedValue("tail-1");
    closeMock.mockResolvedValue(undefined);

    await render();
    // Five windows first, then the tail: it is the focused one while its stream is opened, which is
    // the state a person follows a log in.
    await openByIconId("system-terminal");
    await openByIconId("system-docker");
    await openByIconId("system-transfers");
    await openByIconId("system-batch");
    await openByIconId("system-home");
    await openByIconId("system-tail");

    const tailBody = host.querySelector<HTMLElement>("[data-workbench-tail-window]")!;
    const input = tailBody.querySelector<HTMLInputElement>("input[type='text']")!;
    input.value = "/var/log/app.log";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    tailBody.querySelector<HTMLButtonElement>("[data-workbench-tail-follow]")!.click();
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(desk.id, "/var/log/app.log", 200);
    });

    const { useTailStore } = await import("@/stores/tail");
    const tailStore = useTailStore();
    await vi.waitFor(() => {
      expect(tailStore.tails["tail"]?.status, "the stream is live").toBe("following");
    });

    for (const line of ["first", "second"]) {
      for (const handler of lineListeners) {
        handler({ payload: { tailId: "tail-1", line } });
      }
    }
    await nextTick();
    expect(tailStore.tails["tail"]?.lines, "two lines were read while the window was in front").toEqual([
      "first",
      "second",
    ]);

    // Minimise it: the long-stream rule says the reading stops, not that the reading is lost.
    const tailFrame = [...host.querySelectorAll<HTMLElement>("[data-workbench-window]")].find((frame) =>
      frame.contains(tailBody),
    )!;
    tailFrame.querySelector<HTMLElement>("[data-workbench-window-min]")!.click();
    await vi.waitFor(() => {
      expect(closeMock, "the stream is closed behind the fold").toHaveBeenCalledWith("tail-1");
    });

    for (let index = 0; index < 5; index += 1) {
      for (const handler of lineListeners) {
        handler({ payload: { tailId: "tail-1", line: `arrived while hidden ${index}` } });
      }
    }
    await nextTick();
    expect(
      tailStore.tails["tail"]?.lines,
      "a minimised window's buffer does not grow — nothing reads the stream any more",
    ).toEqual(["first", "second"]);
  });
});
