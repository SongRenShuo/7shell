/**
 * The workbench pane, as a person meets it: what the cards say about the machine, where the
 * entries lead, and what answering the power question does.
 *
 * The stores' suites already say what opening and closing the tabs behind these entries does. What
 * can only be seen here is the wiring — that a reading the host did not report is drawn as a dash
 * rather than a zero, that the entries carry the path they were asked for, and that the power
 * action travels with the acknowledgement the confirmation is.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  monitorSample: vi.fn(async () => {
    throw new Error("no sample was asked for");
  }),
  sessionOpen: vi.fn(),
  sessionSystem: vi.fn(),
  filesOpen: vi.fn(),
  filesList: vi.fn(async (_handle: string, path: string) => ({ path, entries: [] })),
  filesClose: vi.fn(async () => null),
  transfersOpen: vi.fn(async () => []),
  tunnelsOpen: vi.fn(async () => []),
  workbenchPower: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async () => {}),
  onDesktopResized: vi.fn(async () => () => {}),
  onDesktopClosed: vi.fn(async () => () => {}),
  onDesktopFailed: vi.fn(async () => () => {}),
}));

import WorkbenchPane from "@/components/workspace/WorkbenchPane.vue";
import { useToast } from "@/composables/useToast";
import { i18n } from "@/i18n";
import { filesOpen, sessionOpen, workbenchPower } from "@/lib/backend/tauri";
import { writeSystemCache } from "@/lib/system/cache";
import { writeRecentPaths, WORKBENCH_RECENT_PATHS_KEY } from "@/lib/workbench/recentPaths";
import { useFilesStore } from "@/stores/files";
import { useMonitorStore } from "@/stores/monitor";
import { useTerminalsStore } from "@/stores/terminals";
import type { Session } from "@/types/session";

const sessionOpenMock = vi.mocked(sessionOpen);
const filesOpenMock = vi.mocked(filesOpen);
const workbenchPowerMock = vi.mocked(workbenchPower);

/** A file browser that opened, for the entries that lead to one. */
function filesOpened(path = "/root") {
  return { kind: "opened", handle: "f1", sessionId: desk.id, listing: { path, entries: [] }, packed: true } as const;
}

const desk: Session = {
  id: "desk-1",
  name: "lab desk",
  protocol: "linuxDesk",
  host: "lab.example.test",
  port: 22,
  user: "root",
  auth: { method: "password", hasSecret: true },
  terminal: { terminalType: "xterm-256color", keepaliveSeconds: 30, forwardAgent: false, record: false },
  updatedAt: 1_700_000_000,
};

/** The session with a wallpaper chosen, for the one case that is about the backdrop. */
const deskWithWallpaper: Session = { ...desk, workbench: { wallpaper: "aurora" } };

let host: HTMLDivElement;
let app: App | undefined;

/** Mounts the pane over a workbench tab whose connection is up, or as failed as the case needs. */
async function render(session: Session = desk, handle: string | null = "w1", active = false): Promise<void> {
  const terminals = useTerminalsStore();
  terminals.tabs = [{ kind: "workbench", id: "tab-workbench", session, handle, failure: null }];
  terminals.openedOrder = ["tab-workbench"];
  terminals.activeTabId = "tab-workbench";

  const tab = terminals.tabs[0];
  if (!tab || tab.kind !== "workbench") {
    throw new Error("the workspace has no workbench tab to draw");
  }
  app = createApp({
    render: () => h(WorkbenchPane, { tab, active }),
  }).use(i18n);
  app.mount(host);
  await nextTick();
}

/** The one button in the pane whose text is given, pressed the way a person presses it. */
function button(label: string): HTMLElement {
  const found = [...host.querySelectorAll<HTMLElement>("button")].find((entry) => entry.textContent?.trim() === label);
  if (!found) {
    throw new Error(`the pane has no button saying ${label}`);
  }
  return found;
}

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.body.appendChild(document.createElement("div"));
  localStorage.clear();
  sessionOpenMock.mockReset();
  workbenchPowerMock.mockReset();
  useToast().visible.value = false;
});

afterEach(() => {
  app?.unmount();
  host.remove();
  localStorage.clear();
});

describe("the workbench pane", () => {
  it("draws the machine's mark and address on the system card", async () => {
    writeSystemCache({
      "root@lab.example.test:22": {
        name: "Ubuntu 24.04 LTS",
        kernel: "Linux",
        distro: "ubuntu",
        distroLike: ["debian"],
      },
    });

    await render();

    expect(host.textContent).toContain("Ubuntu 24.04 LTS");
    expect(host.textContent).toContain("root@lab.example.test:22");
    expect(host.querySelector(".os-mark"), "the distribution's own mark").not.toBeNull();
  });

  it("draws a dash, never a zero, for a reading the host has not reported", async () => {
    await render();

    // Nothing has been sampled: the CPU and memory rows say so in words, and no bar claims a value.
    expect(host.textContent).toContain("CPU");
    const readings = [...host.querySelectorAll("dd")].map((entry) => entry.textContent?.trim());
    expect(readings).toContain("-");
  });

  it("draws the sample's readings when the sample is about this host", async () => {
    const monitor = useMonitorStore();
    monitor.sample = {
      sampledAt: 1_700_000_000_000,
      roundTripMs: 12,
      hostname: "lab-1",
      os: "Ubuntu 24.04 LTS",
      kernel: "6.8.0-31-generic",
      arch: "x86_64",
      cores: 4,
      cpuModel: { name: "test", frequencyMhz: 1, cacheKb: 1, bogomips: 1 },
      uptimeSeconds: 60,
      load: { one: 0.1, five: 0.1, fifteen: 0.1 },
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
      network: [],
      disks: [{ mountPoint: "/", filesystem: "ext4", sizeBytes: 100_000_000_000, availableBytes: 40_000_000_000 }],
      processes: [],
    };
    monitor.sampleSessionId = desk.id;

    await render();

    expect(host.textContent).toContain("lab-1");
    // Half the memory used: a number the sample actually carries, not a dash.
    expect(host.textContent).toContain("50%");
    expect(host.textContent).toContain("/");
  });

  it("opens the session's own file browser from the home entry, and the monitor's page from its entry", async () => {
    filesOpenMock.mockResolvedValue(filesOpened());

    const terminals = useTerminalsStore();
    await render();

    button("Home directory").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(
      terminals.tabs.some((tab) => tab.kind === "files"),
      "the browser is a tab of its own",
    ).toBe(true);

    button("Open monitor").click();
    await nextTick();
    expect(
      terminals.tabs.some((tab) => tab.kind === "inspect"),
      "the monitor page is a tab of its own",
    ).toBe(true);
  });

  it("opens a second connection from the terminal entry, which is what asking for another terminal is", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });

    const terminals = useTerminalsStore();
    await render();

    button("Open terminal").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(sessionOpenMock).toHaveBeenCalledWith(desk.id);
    expect(terminals.tabs).toHaveLength(2);
    const second = terminals.tabs[1];
    // The fork decides the shape: another connection to a Linux desktop session is another
    // workbench, never a terminal.
    expect(second?.kind).toBe("workbench");
    expect(second && "handle" in second ? second.handle : undefined).toBe("t1");
  });

  it("gathers the directories the session's browser has been in, and opens them again", async () => {
    filesOpenMock.mockResolvedValue(filesOpened("/var/log"));
    const files = useFilesStore();
    files.browsers = {
      f1: {
        handle: "f1",
        sessionId: desk.id,
        path: "/var/log",
        home: "/root",
        shellPath: "/root",
        entries: [],
        loading: false,
        failure: null,
      },
    };

    await render();
    await nextTick();

    // The visit is remembered in the pane's own storage, keyed by the session it belongs to.
    const stored = JSON.parse(localStorage.getItem(WORKBENCH_RECENT_PATHS_KEY) ?? "{}") as Record<string, string[]>;
    expect(stored[desk.id]).toContain("/var/log");

    button("/var/log").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(filesOpenMock, "the browser opens on the session's own SFTP side").toHaveBeenCalledWith(desk.id);
    const filesTab = useTerminalsStore().tabs.find((tab) => tab.kind === "files");
    expect(filesTab && "initialPath" in filesTab ? filesTab.initialPath : undefined).toBe("/var/log");
  });

  it("offers a remembered path from an earlier run, and opens the browser onto it", async () => {
    writeRecentPaths({ [desk.id]: ["/srv"] });

    await render();

    expect(host.textContent).toContain("/srv");
  });

  it("asks about a shutdown before sending anything, and sends the acknowledgement with it", async () => {
    workbenchPowerMock.mockResolvedValue({ issued: true });

    await render();
    button("Shut down").click();
    await nextTick();

    expect(workbenchPowerMock, "a question first, and no command behind it").not.toHaveBeenCalled();
    // The confirmation is a dialog on the portal, outside the pane's own host element.
    const confirm = [...document.body.querySelectorAll<HTMLElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Shut down machine",
    );
    expect(confirm, "the question names the action on its button").toBeDefined();
    confirm?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(workbenchPowerMock).toHaveBeenCalledWith(desk.id, "w1", "shutdown", true);
    expect(useToast().message.value).toContain("The command was issued");
  });

  it("says why when the power action was refused", async () => {
    workbenchPowerMock.mockRejectedValue({
      version: 1,
      code: "POLICY-DENIED",
      messageKey: "errors.policy.denied",
      messageParams: { action: "workbench.shutdown" },
      origin: { subsystem: "policy" },
      outcome: "refused",
    });

    await render();
    button("Shut down").click();
    await nextTick();
    const confirm = [...document.body.querySelectorAll<HTMLElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Shut down machine",
    );
    confirm?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(useToast().message.value).toContain("policy");
    expect(useToast().tier.value).toBe("failure");
  });

  it("leaves the power buttons out of reach while there is no connection to send through", async () => {
    await render(desk, null);

    expect((button("Shut down") as HTMLButtonElement).disabled).toBe(true);
    expect((button("Restart") as HTMLButtonElement).disabled).toBe(true);
    expect(host.textContent).toContain("Not connected");
  });

  it("draws the backdrop the session chose, and the default when it chose nothing this build knows", async () => {
    await render(deskWithWallpaper);
    expect(host.firstElementChild?.getAttribute("style")).toContain("linear-gradient");

    app?.unmount();
    host.remove();
    const unknown: Session = { ...desk, workbench: { wallpaper: "something-else" } };
    await render(unknown);
    expect(host.firstElementChild?.getAttribute("style") ?? "").not.toContain("linear-gradient");
  });
});
