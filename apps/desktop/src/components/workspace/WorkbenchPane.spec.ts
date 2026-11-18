/**
 * The workbench pane, as a person meets it: a desktop with icons, a right-click menu where the
 * thing under the pointer can answer, a taskbar of this session's tabs, and the one question the
 * desktop still asks before the machine does what it is told.
 *
 * The stores' suites already say what opening and closing the tabs behind these doors does, and the
 * ContextMenu component's own suite says how a menu is drawn. What can only be seen here is the
 * wiring — that the icons are doors and not pages, that a shortcut is remembered where shortcuts
 * live, that the taskbar mirrors the session's tabs, and that the power action travels with the
 * acknowledgement the confirmation is.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  sessionOpen: vi.fn(),
  sessionSystem: vi.fn(),
  terminalClose: vi.fn(async () => null),
  filesOpen: vi.fn(),
  filesList: vi.fn(async (_handle: string, path: string) => ({ path, entries: [] })),
  filesClose: vi.fn(async () => null),
  transfersOpen: vi.fn(async () => []),
  tunnelsOpen: vi.fn(async () => []),
  workbenchPower: vi.fn(),
  trashList: vi.fn(async () => []),
  systemOverview: vi.fn(),
  systemJournal: vi.fn(),
  trashRestore: vi.fn(),
  trashRemove: vi.fn(),
  trashEmpty: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async () => {}),
  onDesktopResized: vi.fn(async () => () => {}),
  onDesktopClosed: vi.fn(async () => () => {}),
  onDesktopFailed: vi.fn(async () => () => {}),
}));

import WorkbenchPane from "@/components/workspace/WorkbenchPane.vue";
import { useToast } from "@/composables/useToast";
import { useContextMenu } from "@/composables/useContextMenu";
import { i18n } from "@/i18n";
import { filesList, filesOpen, sessionOpen, systemOverview, trashList, workbenchPower } from "@/lib/backend/tauri";
import {
  readDesktopShortcuts,
  writeDesktopShortcuts,
  WORKBENCH_DESKTOP_SHORTCUTS_KEY,
  type DesktopShortcut,
} from "@/lib/workbench/desktopIcons";
import { iconOrderKey } from "@/lib/workbench/iconOrder";
import { hiddenDoorsKey } from "@/lib/workbench/hiddenDoors";
import { useTerminalsStore } from "@/stores/terminals";
import type { Session } from "@/types/session";

const trashListMock = vi.mocked(trashList);
const systemOverviewMock = vi.mocked(systemOverview);

const sessionOpenMock = vi.mocked(sessionOpen);
const filesOpenMock = vi.mocked(filesOpen);
const filesListMock = vi.mocked(filesList);
const workbenchPowerMock = vi.mocked(workbenchPower);

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
async function render(session: Session = desk, handle: string | null = "w1", active = true): Promise<void> {
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

/** Every desktop icon, in the order the grid draws them. */
function icons(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-workbench-icon]")];
}

/** Every icon's label, in the order the grid draws them. */
function iconLabels(): (string | undefined)[] {
  return icons().map((entry) => entry.textContent?.trim());
}

/** The order this desktop draws before anybody arranges or hides anything: every door visible. */
const DEFAULT_ICON_LABELS = [
  "Home",
  "Terminal",
  "Docker",
  "Monitor",
  "System information",
  "System panel",
  "Transfers",
  "Forwards",
  "Logs",
  "Batch",
  "Trash",
];

function iconByLabel(label: string): HTMLElement {
  const found = icons().find((entry) => entry.textContent?.trim() === label);
  if (!found) {
    throw new Error(`the desktop has no icon saying ${label}`);
  }
  return found;
}

function taskbarEntries(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-workbench-taskbar-entry]")];
}

/** The application ids the starter offers, closed or not: the sheet keeps its tiles in the DOM. */
function starterAppIds(): string[] {
  return [...host.querySelectorAll<HTMLElement>("[data-workbench-starter-app]")].map(
    (entry) => entry.dataset.appId ?? "",
  );
}

/** Opens the desktop's own settings dialog the way its menu does, and waits for it to draw. */
async function openSettings(): Promise<void> {
  fire(host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement, "contextmenu");
  await runMenuEntry(lastMenu(), "desktop-settings");
  await nextTick();
}

/** The settings checkbox of one hideable door, pressed the way a person presses it. */
function settingDoor(id: string): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>(`[data-workbench-setting-door][data-door-id="${id}"]`);
  if (!found) {
    throw new Error(`the settings dialog has no checkbox for ${id}`);
  }
  return found;
}

/** The context menu the pane last opened, read where the composable keeps it. */
function lastMenu(): ReturnType<typeof useContextMenu> {
  return useContextMenu();
}

/** Runs the one entry of the open menu whose id is given, the way a click on its row would. */
async function runMenuEntry(menu: ReturnType<typeof useContextMenu>, id: string): Promise<void> {
  const entry = menu.entries.value.find((candidate) => candidate.kind === "action" && candidate.id === id);
  if (!entry || entry.kind !== "action") {
    throw new Error(`the menu has no entry called ${id}`);
  }
  entry.run();
  await nextTick();
}

/** The one button in a dialog whose text is given, pressed the way a person presses it. */
function dialogButton(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!found) {
    throw new Error(`no dialog button says ${label}`);
  }
  return found;
}

function fire(element: HTMLElement, type: string): void {
  element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true }));
}

/**
 * Drags one icon onto another — or onto the wallpaper, when `onto` is left out — the way a browser
 * does it: dragstart on the source, dragover and drop on the target, then dragend on the source.
 *
 * The events are plain `Event`s: what this pane reads from a drag is which icon was picked up and
 * which one was dropped on, and the transfer itself is only the browser's own carriage.
 */
function drag(from: HTMLElement, onto: HTMLElement | null = null): void {
  const target = onto ?? (host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement);
  from.dispatchEvent(new Event("dragstart", { bubbles: true }));
  target.dispatchEvent(new Event("dragover", { bubbles: true, cancelable: true }));
  target.dispatchEvent(new Event("drop", { bubbles: true, cancelable: true }));
  from.dispatchEvent(new Event("dragend", { bubbles: true }));
}

/** Takes the pane down the way closing its tab does, leaving storage exactly as it is. */
function unmount(): void {
  app?.unmount();
  app = undefined;
  host.remove();
}

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.body.appendChild(document.createElement("div"));
  localStorage.clear();
  sessionOpenMock.mockReset();
  filesOpenMock.mockReset();
  filesOpenMock.mockResolvedValue({
    kind: "opened",
    handle: "f1",
    sessionId: desk.id,
    listing: { path: "/root", entries: [] },
    packed: true,
  });
  workbenchPowerMock.mockReset();
  useToast().visible.value = false;
  useContextMenu().closeMenu();
});

afterEach(() => {
  app?.unmount();
  host.remove();
  localStorage.clear();
  useContextMenu().closeMenu();
});

describe("the workbench desktop", () => {
  it("lays the fixed doors out from the top left, the trash among them and openable", async () => {
    await render();

    const labels = icons().map((entry) => entry.textContent?.trim());
    expect(labels).toEqual(DEFAULT_ICON_LABELS);

    const trash = iconByLabel("Trash");
    expect((trash as HTMLButtonElement).disabled, "the trash is a door now, not a placeholder").toBe(false);
    expect(trash.getAttribute("title"), "a door needs no apology in its title").toBeNull();
  });

  it("keeps the closed starter's layer out of the way of every icon", async () => {
    await render();

    const layer = host.querySelector<HTMLElement>("[data-workbench-starter-layer]");
    expect(layer, "the sheet is mounted in a layer of its own").not.toBeNull();
    // The layer sits above the desktop so the sheet can cover it; while the sheet is closed it must
    // pass presses through. A transparent box covering the desk that answers clicks is invisible and
    // total: every icon stops working, and nothing on the page looks wrong.
    expect(layer!.className, "a closed sheet's layer is click-through").toContain("pointer-events-none");
    expect(
      layer!.querySelector("[data-workbench-starter]")?.getAttribute("inert"),
      "and the closed sheet is inert as well",
    ).toBe("");
  });

  it("opens the trash panel from its icon, and the panel reads the machine's trash once", async () => {
    trashListMock.mockResolvedValue([
      { id: "notes.txt", name: "notes.txt", originalPath: "/root/notes.txt", deletedAt: 1, isDir: false },
    ]);
    await render();

    // A desktop opens on the second click; the first one only selects.
    iconByLabel("Trash").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(trashListMock).toHaveBeenCalledWith("w1");
    expect(host.querySelector("[data-workbench-trash]"), "the panel is drawn over the desktop").not.toBeNull();
  });

  it("opens the system panel and the trash in windows of their own, side by side", async () => {
    systemOverviewMock.mockResolvedValue({
      services: [],
      disks: [],
      accounts: [],
      interfaces: [],
      routes: [],
      dns: [],
      crontab: [],
      logins: [],
      mounts: [],
      uptimeSeconds: 60,
    });
    await render();

    const panel = () => host.querySelector("[data-workbench-system]");
    const trash = () => host.querySelector("[data-workbench-trash]");

    iconByLabel("Trash").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(trash(), "the trash opened first").not.toBeNull();

    iconByLabel("System panel").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(panel(), "the system panel is drawn").not.toBeNull();
    expect(trash(), "a desktop puts each surface in its own window, so both stand").not.toBeNull();
    expect(host.querySelectorAll("[data-workbench-window]"), "two windows, one per surface").toHaveLength(2);
    expect(systemOverviewMock).toHaveBeenCalledWith("w1");
  });

  it("draws a disk tree whose leaves carry no children key, the shape the shell actually sends", async () => {
    // The Rust side omits an empty vector, so a leaf device arrives without `children` at all.
    // A mirror that typed it as always-present threw "not iterable" the first time this page met
    // a real machine; this fixture is that machine's shape.
    systemOverviewMock.mockResolvedValue({
      services: [],
      disks: [
        { name: "loop0", size: "61.9M", kind: "loop", mount: "/snap/core20/1434", filesystem: "squashfs" },
        {
          name: "sda",
          size: "200G",
          kind: "disk",
          children: [{ name: "sda1", size: "200G", kind: "part", mount: "/" }],
        },
      ],
      accounts: [],
      interfaces: [],
      routes: [],
      dns: [],
      crontab: [],
      logins: [],
      mounts: [],
      uptimeSeconds: 60,
    } as never);
    await render();

    iconByLabel("System panel").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    const disk = [...host.querySelectorAll("[data-workbench-system-tabs] button")].find((button) =>
      button.textContent?.includes("Disks"),
    );
    disk?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(host.querySelector("[data-workbench-system]"), "the panel survives a leaf device").not.toBeNull();
    const text = [...host.querySelectorAll("[data-workbench-system] tbody tr")].map((row) => row.textContent ?? "");
    expect(
      text.some((line) => line.includes("loop0")),
      "the leaf is drawn",
    ).toBe(true);
    expect(
      text.some((line) => line.includes("sda1")),
      "the child is drawn",
    ).toBe(true);
  });

  it("keeps the system panel open while its sections are switched", async () => {
    systemOverviewMock.mockResolvedValue({
      services: [{ name: "sshd.service", load: "loaded", active: "active", sub: "running", description: "OpenSSH" }],
      disks: [
        {
          name: "sda",
          size: "20G",
          kind: "disk",
          children: [{ name: "sda1", size: "20G", kind: "part", mount: "/", children: [] }],
        },
      ],
      accounts: [],
      interfaces: [],
      routes: [],
      dns: [],
      crontab: [],
      logins: [],
      mounts: [],
      uptimeSeconds: 60,
    });
    await render();

    iconByLabel("System panel").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    const panel = () => host.querySelector("[data-workbench-system]");
    expect(panel(), "the panel opened").not.toBeNull();

    // Switching a section is a click on a tab, and it must leave the panel standing: it used to be
    // reported as closing the whole panel, which is the difference between a tab strip and a door.
    const disk = [...host.querySelectorAll("[data-workbench-system-tabs] button")].find((button) =>
      button.textContent?.includes("Disks"),
    );
    disk?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(panel(), "the panel is still standing").not.toBeNull();
    const cells = [...host.querySelectorAll("[data-workbench-system] tbody tr")].map((row) => row.textContent ?? "");
    expect(
      cells.some((text) => text.includes("sda1")),
      "the disk tree is drawn",
    ).toBe(true);
  });

  it("keeps the panel standing when the host answers an older shape without the newer lists", async () => {
    // A browser host older than this build answers the overview without `crontab`, `logins` or
    // `mounts`. That is not a contract violation to crash over: the sections say they have nothing
    // to show. `overview?.crontab.length` reads `crontab` before it is known to exist, and Vue
    // unmounts the subtree when that throws — the panel disappears with no other symptom.
    systemOverviewMock.mockResolvedValue({
      services: [],
      disks: [],
      accounts: [],
      interfaces: [],
      routes: [],
      dns: [],
      uptimeSeconds: 60,
    } as never);
    await render();

    iconByLabel("System panel").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector("[data-workbench-system]"), "the panel opened").not.toBeNull();

    for (const label of ["Scheduled jobs", "Logins", "Disks"]) {
      const button = [...host.querySelectorAll("[data-workbench-system-tabs] button")].find(
        (tab) => tab.textContent?.trim() === label,
      );
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
      await nextTick();
      expect(host.querySelector("[data-workbench-system]"), `the panel survives ${label}`).not.toBeNull();
    }
  });

  it("draws the backdrop the session chose over the whole tab, and the surface when it chose nothing", async () => {
    await render(deskWithWallpaper);
    expect(host.firstElementChild?.getAttribute("style")).toContain("var(--workbench-wallpaper-");

    app?.unmount();
    host.remove();
    const unknown: Session = { ...desk, workbench: { wallpaper: "something-else" } };
    await render(unknown);
    expect(host.firstElementChild?.getAttribute("style") ?? "").not.toContain("var(--workbench-wallpaper-");
  });

  it("dresses its chrome from the workbench tokens, with no literal colour left in the pane", () => {
    // The pane is the assembler of the desktop's chrome; the wallpaper gradients, the icon labels'
    // shadow and every surface colour are named in globals.css. The probe is the source itself.
    const source = readFileSync(resolve("apps/desktop/src/components/workspace/WorkbenchPane.vue"), "utf8");
    expect(source, "wallpapers come from the workbench tokens").toContain("var(--workbench-wallpaper-");
    expect(source, "icon labels carry the the reference two-layer shadow").toContain("var(--wb-shadow-text-picture)");
    expect(source, "no literal colour is left in the pane").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("opens the session's own file browser in a window on a double-click of Home, not on a single click", async () => {
    filesOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "f1",
      sessionId: desk.id,
      listing: { path: "/root", entries: [] },
      packed: true,
    });
    await render();

    fire(iconByLabel("Home"), "click");
    await nextTick();
    expect(host.querySelector("[data-workbench-window]"), "a click selects, it does not open").toBeNull();

    fire(iconByLabel("Home"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector("[data-workbench-window]"), "the browser has a window").not.toBeNull();
    expect(filesOpenMock, "the browser is this window's own, opened for this session").toHaveBeenCalledWith(desk.id);
  });

  it("opens the file browser onto a shortcut's path when the shortcut opens", async () => {
    filesOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "f1",
      sessionId: desk.id,
      listing: { path: "/root", entries: [] },
      packed: true,
    });
    writeDesktopShortcuts({ [desk.id]: [{ id: "s1", path: "/srv/data" }] });
    await render();

    fire(iconByLabel("data"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(host.querySelector("[data-workbench-window]"), "the shortcut opens a window").not.toBeNull();
    expect(
      filesListMock.mock.calls.some(([handle, path]) => handle === "f1" && path === "/srv/data"),
      "the window walks to the path the shortcut names",
    ).toBe(true);
  });

  it("opens a second connection from the Terminal icon, in a window rather than a tab of the strip", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });

    const terminals = useTerminalsStore();
    await render();

    fire(iconByLabel("Terminal"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(sessionOpenMock).toHaveBeenCalledWith(desk.id);
    expect(terminals.tabs).toHaveLength(2);
    const second = terminals.tabs[1];
    // The icon says terminal, so a terminal is what mounts — `open` would fork to another
    // workbench, which is why the pane asks the store for the terminal-only path. It is marked
    // windowed so the strip leaves it to the desktop.
    expect(second?.kind).toBe("terminal");
    expect(second && "windowed" in second ? second.windowed : undefined).toBe(true);
    expect(host.querySelector("[data-workbench-window]"), "the terminal is drawn in a window").not.toBeNull();
  });

  it("opens the monitor's system page from both monitor doors, in a single window", async () => {
    await render();

    fire(iconByLabel("Monitor"), "dblclick");
    await nextTick();
    expect(host.querySelectorAll("[data-workbench-window]"), "the system page has a window").toHaveLength(1);

    fire(iconByLabel("System information"), "dblclick");
    await nextTick();
    expect(
      host.querySelectorAll("[data-workbench-window]"),
      "a second ask raises the window that is already there",
    ).toHaveLength(1);
  });

  it("opens the selected icon with the Enter key, the way a desktop's keyboard works", async () => {
    await render();

    fire(iconByLabel("Home"), "click");
    await nextTick();
    iconByLabel("Home").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(
      host.querySelector("[data-workbench-window]"),
      "Enter opens the same door a double-click does",
    ).not.toBeNull();
  });

  it("offers what the desktop can do from its own right-click, and refresh rereads storage", async () => {
    writeDesktopShortcuts({ [desk.id]: [{ id: "s1", path: "/srv/a" }] });
    await render();
    expect(iconByLabel("a")).toBeDefined();

    // Somebody else — an earlier close, another pane — changed what storage holds since the desktop
    // was drawn; refresh is how the desktop catches up.
    writeDesktopShortcuts({
      [desk.id]: [
        { id: "s1", path: "/srv/a" },
        { id: "s2", path: "/srv/b" },
      ],
    });

    const menu = lastMenu();
    fire(host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement, "contextmenu");
    await nextTick();
    expect(menu.visible.value, "the desktop's own menu is up").toBe(true);
    expect(menu.title.value.key).toBe("workbench.desktop.title");

    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : entry.kind));
    expect(ids).toContain("desktop-refresh");
    expect(ids).toContain("desktop-new-shortcut");
    expect(ids, "the desktop's settings entry is offered").toContain("desktop-settings");
    const settings = menu.entries.value.find((entry) => entry.kind === "action" && entry.id === "desktop-settings");
    expect(
      settings && settings.kind === "action" ? (settings.disabled ?? false) : false,
      "settings is a door now",
    ).toBe(false);
    if (settings && settings.kind === "action") {
      settings.run();
      await nextTick();
      expect(document.body.querySelector("[data-workbench-settings]"), "the settings dialog is drawn").not.toBeNull();
    }
    await runMenuEntry(menu, "desktop-refresh");
    expect(iconByLabel("b"), "the shortcut added elsewhere is now on the desktop").toBeDefined();
  });

  it("moves an icon onto another by dragging, and keeps the arrangement for the next visit", async () => {
    const terminals = useTerminalsStore();
    await render();

    drag(iconByLabel("Trash"), iconByLabel("Home"));
    await nextTick();

    const arranged = [
      "Trash",
      "Home",
      "Terminal",
      "Docker",
      "Monitor",
      "System information",
      "System panel",
      "Transfers",
      "Forwards",
      "Logs",
      "Batch",
    ];
    expect(iconLabels()).toEqual(arranged);
    expect(terminals.tabs, "a drag opens nothing").toHaveLength(1);
    expect(iconByLabel("Trash").className, "and it does not select what it picked up, either").not.toContain(
      "bg-accent text-foreground",
    );

    // What storage holds is ids, not slots: the same icon stays the same entry when the list grows.
    expect(JSON.parse(localStorage.getItem(iconOrderKey(desk.id)) ?? "null")).toEqual([
      "system-trash",
      "system-home",
      "system-terminal",
      "system-docker",
      "system-monitor",
      "system-info",
      "system-panel",
      "system-transfers",
      "system-forwards",
      "system-tail",
      "system-batch",
    ]);

    // A later visit draws the arrangement storage holds.
    unmount();
    await render();
    expect(iconLabels()).toEqual(arranged);
  });

  it("moves an icon to the end when it is dropped on the wallpaper", async () => {
    await render();

    drag(iconByLabel("Home"));
    await nextTick();

    expect(iconLabels()).toEqual([
      "Terminal",
      "Docker",
      "Monitor",
      "System information",
      "System panel",
      "Transfers",
      "Forwards",
      "Logs",
      "Batch",
      "Trash",
      "Home",
    ]);
  });

  it("drops an id whose icon is gone, and puts a newly added icon at the end", async () => {
    writeDesktopShortcuts({ [desk.id]: [{ id: "s1", path: "/srv/data" }] });
    localStorage.setItem(iconOrderKey(desk.id), JSON.stringify(["system-trash", "system-home", "shortcut:gone"]));

    await render();

    expect(iconLabels()).toEqual([
      "Trash",
      "Home",
      "Terminal",
      "Docker",
      "Monitor",
      "System information",
      "System panel",
      "Transfers",
      "Forwards",
      "Logs",
      "Batch",
      "data",
    ]);
  });

  it("falls back to the default order when the stored arrangement is unreadable", async () => {
    localStorage.setItem(iconOrderKey(desk.id), "not json at all");
    await render();
    expect(iconLabels()).toEqual(DEFAULT_ICON_LABELS);

    unmount();
    localStorage.setItem(iconOrderKey(desk.id), JSON.stringify({ order: ["system-trash"] }));
    await render();
    expect(iconLabels()).toEqual(DEFAULT_ICON_LABELS);
  });

  it("hides a door from the grid and the starter when the settings ask, and remembers the choice", async () => {
    await render();

    await openSettings();
    expect(
      document.body.querySelectorAll("[data-workbench-setting-door]").length,
      "the mutable doors can be checked off; home and the trash are not anybody's to hide",
    ).toBe(9);

    settingDoor("system-docker").click();
    await nextTick();

    const withoutDocker = DEFAULT_ICON_LABELS.filter((label) => label !== "Docker");
    expect(iconLabels(), "the door is off the grid").toEqual(withoutDocker);
    expect(starterAppIds(), "and off the starter — two places saying one thing").not.toContain("docker");
    expect(iconByLabel("Trash"), "home and the trash stay, whatever else leaves").toBeDefined();
    expect(localStorage.getItem(hiddenDoorsKey(desk.id)), "and the choice is written down").toBe(
      JSON.stringify(["system-docker"]),
    );

    unmount();
    await render();
    expect(iconLabels(), "the next visit opens a desktop without it too").toEqual(withoutDocker);
    expect(starterAppIds()).not.toContain("docker");
  });

  it("falls back to every door visible when the stored choice is unreadable", async () => {
    localStorage.setItem(hiddenDoorsKey(desk.id), "not json at all");
    await render();
    expect(iconLabels()).toEqual(DEFAULT_ICON_LABELS);

    unmount();
    localStorage.setItem(hiddenDoorsKey(desk.id), JSON.stringify({ hidden: ["system-docker"] }));
    await render();
    expect(iconLabels()).toEqual(DEFAULT_ICON_LABELS);

    unmount();
    localStorage.setItem(hiddenDoorsKey(desk.id), JSON.stringify(["system-gone", "system-docker"]));
    await render();
    expect(iconLabels(), "an id this build cannot hide is dropped; the rest of the choice stands").toEqual(
      DEFAULT_ICON_LABELS.filter((label) => label !== "Docker"),
    );
  });

  it("puts a hidden door back where the arrangement left it when it is shown again", async () => {
    await render();

    // The arrangement first: Batch takes Home's slot, and the stored order keeps every id it saw,
    // whether the door is on the wall or not.
    drag(iconByLabel("Batch"), iconByLabel("Home"));
    await nextTick();
    const arranged = [
      "Batch",
      "Home",
      "Terminal",
      "Docker",
      "Monitor",
      "System information",
      "System panel",
      "Transfers",
      "Forwards",
      "Logs",
      "Trash",
    ];
    expect(iconLabels()).toEqual(arranged);

    await openSettings();
    settingDoor("system-docker").click();
    await nextTick();
    expect(iconLabels(), "the door leaves the grid, the arrangement untouched").toEqual(
      arranged.filter((label) => label !== "Docker"),
    );

    settingDoor("system-docker").click();
    await nextTick();
    expect(
      iconLabels(),
      "shown again, it is exactly where somebody dragged it to be — not appended at the end",
    ).toEqual(arranged);
  });

  it("moves the taskbar to the middle when the settings ask, and remembers the choice", async () => {
    await render();
    expect(host.querySelector("[data-workbench-taskbar]")?.classList.contains("is-centered")).toBe(false);

    await openSettings();
    const center = document.body.querySelector<HTMLElement>('[data-workbench-setting-align][data-align="center"]');
    if (!center) {
      throw new Error("the settings dialog has no centre choice for the taskbar");
    }
    center.click();
    await nextTick();

    expect(host.querySelector("[data-workbench-taskbar]")?.classList.contains("is-centered")).toBe(true);
    expect(localStorage.getItem("sevenshell-workbench-taskbar-align")).toBe("center");

    unmount();
    await render();
    expect(
      host.querySelector("[data-workbench-taskbar]")?.classList.contains("is-centered"),
      "the next visit draws it centred too",
    ).toBe(true);
  });

  it("puts the default order back from the desktop's menu, and forgets the arrangement", async () => {
    localStorage.setItem(iconOrderKey(desk.id), JSON.stringify(["system-trash", "system-home"]));
    await render();
    expect(iconLabels()[0]).toBe("Trash");

    const menu = lastMenu();
    fire(host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement, "contextmenu");
    await nextTick();
    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : entry.kind));
    expect(ids, "the desktop offers to put its icons back in their place").toContain("desktop-reset-layout");

    await runMenuEntry(menu, "desktop-reset-layout");
    expect(iconLabels()).toEqual(DEFAULT_ICON_LABELS);
    expect(localStorage.getItem(iconOrderKey(desk.id)), "and storage holds no arrangement").toBeNull();
  });

  it("asks for a path, remembers the shortcut, and refuses to send a draft that is not a path", async () => {
    const terminals = useTerminalsStore();
    await render();

    const menu = lastMenu();
    fire(host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement, "contextmenu");
    await runMenuEntry(menu, "desktop-new-shortcut");
    await nextTick();

    const field = document.body.querySelector<HTMLInputElement>("input");
    expect(field, "the dialog has one field").not.toBeNull();

    // A control character is refused before it is remembered, and the confirm button stays out
    // of reach while the draft is not a path. (A newline never reaches this check: an input of
    // this kind sanitizes those away, which is the browser's own rule, not ours.)
    field!.value = "/srv/a\tb";
    field!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    expect(dialogButton("Create shortcut").getAttribute("disabled")).not.toBeNull();

    field!.value = "/srv/data";
    field!.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    dialogButton("Create shortcut").click();
    await nextTick();

    expect(iconByLabel("data"), "the icon is on the desktop").toBeDefined();
    expect(terminals.tabs, "creating a shortcut opens nothing").toHaveLength(1);
    const stored = readDesktopShortcuts();
    expect(stored[desk.id]?.map((shortcut) => shortcut.path)).toEqual(["/srv/data"]);
    expect(localStorage.getItem(WORKBENCH_DESKTOP_SHORTCUTS_KEY), "and it is written down").toContain("/srv/data");
  });

  it("adds nothing for a path already on the desktop, instead of stacking a second icon", async () => {
    await render();

    const menu = lastMenu();
    fire(host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement, "contextmenu");
    await runMenuEntry(menu, "desktop-new-shortcut");
    await nextTick();

    const field = document.body.querySelector<HTMLInputElement>("input") as HTMLInputElement;
    field.value = "/srv/data";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    dialogButton("Create shortcut").click();
    await nextTick();

    fire(host.querySelector<HTMLElement>("[data-workbench-desktop]") as HTMLElement, "contextmenu");
    await runMenuEntry(menu, "desktop-new-shortcut");
    await nextTick();
    const fieldAgain = document.body.querySelector<HTMLInputElement>("input") as HTMLInputElement;
    fieldAgain.value = "/srv/data";
    fieldAgain.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();
    dialogButton("Create shortcut").click();
    await nextTick();

    expect(icons().filter((entry) => entry.textContent?.trim() === "data")).toHaveLength(1);
  });

  it("offers a shortcut's removal on its own right-click, and takes it off the desktop", async () => {
    const stored: Record<string, DesktopShortcut[]> = { [desk.id]: [{ id: "s1", path: "/srv/data" }] };
    writeDesktopShortcuts(stored);
    await render();

    const shortcut = iconByLabel("data");
    fire(shortcut, "contextmenu");
    await nextTick();

    const menu = lastMenu();
    expect(menu.visible.value).toBe(true);
    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : entry.kind));
    expect(ids, "a shortcut can be opened and removed").toEqual(
      expect.arrayContaining(["icon-open", "icon-remove", "icon-properties"]),
    );

    await runMenuEntry(menu, "icon-remove");
    expect(
      icons().some((entry) => entry.textContent?.trim() === "data"),
      "the icon is gone",
    ).toBe(false);
    expect(readDesktopShortcuts()[desk.id], "and so is its memory").toBeUndefined();
  });

  it("opens a system door's properties for real, and offers no removal from there", async () => {
    await render();

    const menu = lastMenu();
    fire(iconByLabel("Home"), "contextmenu");
    await nextTick();

    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : entry.kind));
    expect(ids).toContain("icon-open");
    expect(ids, "a door every desktop has is not somebody's to remove").not.toContain("icon-remove");

    const properties = menu.entries.value.find((entry) => entry.kind === "action" && entry.id === "icon-properties");
    expect(
      properties && properties.kind === "action" ? properties.disabled : undefined,
      "properties is a door too",
    ).not.toBe(true);
    await runMenuEntry(menu, "icon-properties");

    const dialog = document.body.querySelector<HTMLElement>("[data-workbench-icon-properties]");
    expect(dialog, "the card is drawn").not.toBeNull();
    expect(dialog?.querySelector("[data-properties-name]")?.textContent?.trim()).toBe("Home");
    expect(dialog?.textContent, "and it says what the door opens").toContain("file browser");
    expect(
      [...dialog!.querySelectorAll("button")].some(
        (button) => button.textContent?.trim() === "Remove from the desktop",
      ),
      "a door that is not a shortcut cannot be removed from its own properties",
    ).toBe(false);
  });

  it("shows a shortcut's path in its properties, and copies it", async () => {
    writeDesktopShortcuts({ [desk.id]: [{ id: "s1", path: "/srv/data" }] });
    const written: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    await render();

    const menu = lastMenu();
    fire(iconByLabel("data"), "contextmenu");
    await nextTick();
    await runMenuEntry(menu, "icon-properties");
    await nextTick();

    const dialog = document.body.querySelector<HTMLElement>("[data-workbench-icon-properties]");
    expect(dialog?.querySelector("[data-properties-path]")?.textContent?.trim()).toBe("/srv/data");

    const copy = [...dialog!.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Copy path");
    copy?.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(written, "the path went to the clipboard").toEqual(["/srv/data"]);
    expect(useToast().message.value).toContain("clipboard");
  });

  it("folds a window away before removing it, and takes the tab with it", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });
    const terminals = useTerminalsStore();
    await render();

    fire(iconByLabel("Terminal"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(terminals.tabs).toHaveLength(2);

    host.querySelector<HTMLElement>("[data-workbench-window-close]")!.click();
    await nextTick();
    expect(
      host.querySelector("[data-workbench-window]"),
      "the window is still on screen while the collapse runs",
    ).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 320));
    await nextTick();
    expect(host.querySelector("[data-workbench-window]"), "and is gone once it has folded").toBeNull();
    expect(terminals.tabs, "the tab underneath went with it").toHaveLength(1);
  });

  it("mirrors the open windows in the taskbar, and raises the one that is clicked", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });

    await render();

    expect(taskbarEntries(), "an empty desktop has an empty bar").toHaveLength(0);

    fire(iconByLabel("Terminal"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    fire(iconByLabel("Home"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    const entries = taskbarEntries();
    expect(entries).toHaveLength(2);
    const homeEntry = entries.find((entry) => entry.dataset.entryId?.startsWith("files:"));
    expect(homeEntry?.dataset.active, "the window opened last is the one in front").toBe("true");

    const terminalEntry = entries.find((entry) => entry.dataset.entryId?.startsWith("terminal:"));
    terminalEntry?.click();
    await nextTick();

    const raised = taskbarEntries().find((entry) => entry.dataset.entryId?.startsWith("terminal:"));
    expect(raised?.dataset.active, "the bar raises the window it names").toBe("true");
  });

  it("empties the desk on the desktop button, and brings everything back on the next press", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });

    await render();

    fire(iconByLabel("Terminal"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    fire(iconByLabel("Home"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    const desktop = host.querySelector<HTMLElement>("[data-workbench-taskbar-desktop]");
    expect(desktop, "the bar carries a desktop cell").not.toBeNull();

    desktop!.click();
    await nextTick();
    expect(
      taskbarEntries().every((entry) => entry.dataset.active === undefined),
      "an emptied desk has no front",
    ).toBe(true);

    desktop!.click();
    await nextTick();
    expect(taskbarEntries(), "the second press brings the windows back").toHaveLength(2);
  });

  it("draws a clock at the far end of the taskbar, and clicking it opens the system panel", async () => {
    systemOverviewMock.mockResolvedValue({
      services: [],
      disks: [],
      accounts: [],
      interfaces: [],
      routes: [],
      dns: [],
      crontab: [],
      logins: [],
      mounts: [],
      uptimeSeconds: 60,
    });
    await render();

    const clock = host.querySelector<HTMLElement>("[data-workbench-taskbar-clock]");
    expect(clock, "the bar carries a clock").not.toBeNull();
    expect(clock!.textContent, "the time is on it").toMatch(/\d{2}:\d{2}/);
    expect(clock!.getAttribute("aria-label"), "and it is named for a reader").toBeTruthy();

    // The trash first, so the clock's door has another window to stand beside.
    iconByLabel("Trash").dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector("[data-workbench-trash]"), "the trash opened first").not.toBeNull();

    clock!.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(host.querySelector("[data-workbench-system]"), "the clock is a door to the system panel").not.toBeNull();
    expect(systemOverviewMock).toHaveBeenCalledWith("w1");
  });

  it("reads the clock again on the next minute", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(2026, 10, 18, 9, 5, 0));
      await render();
      expect(host.querySelector("[data-workbench-taskbar-clock]")?.textContent).toContain("09:05");

      // The timers and the wall clock move together: one minute later the tick has to say so.
      vi.advanceTimersByTime(60_000);
      await nextTick();
      expect(
        host.querySelector("[data-workbench-taskbar-clock]")?.textContent,
        "a minute later the bar says so",
      ).toContain("09:06");
    } finally {
      vi.useRealTimers();
    }
  });

  it("asks about a shutdown before sending anything, and sends the acknowledgement with it", async () => {
    workbenchPowerMock.mockResolvedValue({ issued: true });

    await render();
    host.querySelector<HTMLElement>("[data-workbench-taskbar-power]")!.click();
    await nextTick();
    const menu = lastMenu();
    expect(menu.visible.value, "the power control opens the machine's own menu").toBe(true);
    await runMenuEntry(menu, "power-shutdown");

    expect(workbenchPowerMock, "a question first, and no command behind it").not.toHaveBeenCalled();
    // The confirmation is a dialog on the portal, outside the pane's own host element.
    const confirm = dialogButton("Shut down machine");
    confirm.click();
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
    host.querySelector<HTMLElement>("[data-workbench-taskbar-power]")!.click();
    await nextTick();
    await runMenuEntry(lastMenu(), "power-shutdown");
    dialogButton("Shut down machine").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(useToast().message.value).toContain("policy");
    expect(useToast().tier.value).toBe("failure");
  });

  it("leaves the power actions out of reach while there is no connection to send through", async () => {
    await render(desk, null);

    host.querySelector<HTMLElement>("[data-workbench-taskbar-power]")!.click();
    await nextTick();

    const menu = lastMenu();
    const shutdown = menu.entries.value.find((entry) => entry.kind === "action" && entry.id === "power-shutdown");
    const restart = menu.entries.value.find((entry) => entry.kind === "action" && entry.id === "power-reboot");
    expect(shutdown?.kind === "action" ? shutdown.disabled : undefined).toBe(true);
    expect(restart?.kind === "action" ? restart.disabled : undefined).toBe(true);
  });
});
