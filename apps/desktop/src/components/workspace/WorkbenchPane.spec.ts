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
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  sessionOpen: vi.fn(),
  sessionSystem: vi.fn(),
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
import { filesOpen, sessionOpen, systemOverview, trashList, workbenchPower } from "@/lib/backend/tauri";
import {
  readDesktopShortcuts,
  writeDesktopShortcuts,
  WORKBENCH_DESKTOP_SHORTCUTS_KEY,
  type DesktopShortcut,
} from "@/lib/workbench/desktopIcons";
import { useTerminalsStore } from "@/stores/terminals";
import type { Session } from "@/types/session";

const trashListMock = vi.mocked(trashList);
const systemOverviewMock = vi.mocked(systemOverview);

const sessionOpenMock = vi.mocked(sessionOpen);
const filesOpenMock = vi.mocked(filesOpen);
const workbenchPowerMock = vi.mocked(workbenchPower);

/** A file browser that opened, for the doors that lead to one. */
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

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.body.appendChild(document.createElement("div"));
  localStorage.clear();
  sessionOpenMock.mockReset();
  filesOpenMock.mockReset();
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
    expect(labels).toEqual(["Home", "Terminal", "Monitor", "System information", "System panel", "Trash"]);

    const trash = iconByLabel("Trash");
    expect((trash as HTMLButtonElement).disabled, "the trash is a door now, not a placeholder").toBe(false);
    expect(trash.getAttribute("title"), "a door needs no apology in its title").toBeNull();
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

  it("opens the system panel from its icon, and only one panel stands at a time", async () => {
    systemOverviewMock.mockResolvedValue({
      services: [],
      disks: [],
      accounts: [],
      interfaces: [],
      routes: [],
      dns: [],
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
    expect(trash(), "the two panels share the floor, so opening one closes the other").toBeNull();
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

  it("draws the backdrop the session chose over the whole tab, and the surface when it chose nothing", async () => {
    await render(deskWithWallpaper);
    expect(host.firstElementChild?.getAttribute("style")).toContain("linear-gradient");

    app?.unmount();
    host.remove();
    const unknown: Session = { ...desk, workbench: { wallpaper: "something-else" } };
    await render(unknown);
    expect(host.firstElementChild?.getAttribute("style") ?? "").not.toContain("linear-gradient");
  });

  it("opens the session's own file browser on a double-click of Home, not on a single click", async () => {
    filesOpenMock.mockResolvedValue(filesOpened());

    const terminals = useTerminalsStore();
    await render();

    fire(iconByLabel("Home"), "click");
    await nextTick();
    expect(terminals.tabs, "a click selects, it does not open").toHaveLength(1);

    fire(iconByLabel("Home"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    expect(
      terminals.tabs.some((tab) => tab.kind === "files"),
      "the browser is a tab of its own",
    ).toBe(true);
  });

  it("opens the file browser onto a shortcut's path when the shortcut opens", async () => {
    filesOpenMock.mockResolvedValue(filesOpened("/srv/data"));

    const terminals = useTerminalsStore();
    writeDesktopShortcuts({ [desk.id]: [{ id: "s1", path: "/srv/data" }] });
    await render();

    fire(iconByLabel("data"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    const filesTab = terminals.tabs.find((tab) => tab.kind === "files");
    expect(filesTab && "initialPath" in filesTab ? filesTab.initialPath : undefined).toBe("/srv/data");
  });

  it("opens a second connection from the Terminal icon, which is what asking for another terminal is", async () => {
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
    // workbench, which is why the pane asks the store for the terminal-only path.
    expect(second?.kind).toBe("terminal");
    expect(second && "handle" in second ? second.handle : undefined).toBe("t1");
  });

  it("opens the monitor's system page from both monitor doors, as the tab that is already there", async () => {
    const terminals = useTerminalsStore();
    await render();

    fire(iconByLabel("Monitor"), "dblclick");
    await nextTick();
    expect(
      terminals.tabs.filter((tab) => tab.kind === "inspect"),
      "the system page is a tab of its own",
    ).toHaveLength(1);

    fire(iconByLabel("System information"), "dblclick");
    await nextTick();
    expect(
      terminals.tabs.filter((tab) => tab.kind === "inspect"),
      "a second ask does not stack a second copy",
    ).toHaveLength(1);
  });

  it("opens the selected icon with the Enter key, the way a desktop's keyboard works", async () => {
    filesOpenMock.mockResolvedValue(filesOpened());

    const terminals = useTerminalsStore();
    await render();

    fire(iconByLabel("Home"), "click");
    await nextTick();
    iconByLabel("Home").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(terminals.tabs.some((tab) => tab.kind === "files")).toBe(true);
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

  it("offers a system icon its door and its properties, but no removal", async () => {
    await render();

    const menu = lastMenu();
    fire(iconByLabel("Home"), "contextmenu");
    await nextTick();

    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : entry.kind));
    expect(ids).toContain("icon-open");
    expect(ids, "a door every desktop has is not somebody's to remove").not.toContain("icon-remove");
    const properties = menu.entries.value.find((entry) => entry.kind === "action" && entry.id === "icon-properties");
    expect(properties && properties.kind === "action" ? properties.disabled : undefined).toBe(true);
  });

  it("mirrors the session's tabs in the taskbar, and switches to the one that is clicked", async () => {
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      handle: "t1",
      sessionId: desk.id,
      tunnels: [],
      tunnelFailures: [],
    });
    filesOpenMock.mockResolvedValue(filesOpened());

    const terminals = useTerminalsStore();
    await render();

    expect(taskbarEntries(), "an empty session has an empty bar").toHaveLength(0);

    fire(iconByLabel("Terminal"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();
    fire(iconByLabel("Home"), "dblclick");
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    const entries = taskbarEntries();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual(["lab desk", "lab desk"]);

    const filesId = terminals.tabs.find((tab) => tab.kind === "files")?.id ?? "";
    const filesEntry = entries.find((entry) => entry.dataset.tabId === filesId) as HTMLElement;
    expect(filesEntry.className, "the tab on screen is the one the bar lights up").toContain("bg-accent");

    // Going to the terminal's tab: the bar asks the store, which validates what it is handed.
    const terminalId = terminals.tabs.find((tab) => tab.kind === "terminal")?.id ?? "";
    (entries.find((entry) => entry.dataset.tabId === terminalId) as HTMLElement).click();
    await nextTick();
    expect(terminals.activeTabId).toBe(terminalId);
  });

  it("asks about a shutdown before sending anything, and sends the acknowledgement with it", async () => {
    workbenchPowerMock.mockResolvedValue({ issued: true });

    await render();
    [...host.querySelectorAll<HTMLElement>("button")]
      .find((entry) => entry.textContent?.trim() === "Shut down")!
      .click();
    await nextTick();

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
    [...host.querySelectorAll<HTMLElement>("button")]
      .find((entry) => entry.textContent?.trim() === "Shut down")!
      .click();
    await nextTick();
    dialogButton("Shut down machine").click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await nextTick();

    expect(useToast().message.value).toContain("policy");
    expect(useToast().tier.value).toBe("failure");
  });

  it("leaves the power actions out of reach while there is no connection to send through", async () => {
    await render(desk, null);

    const shutdown = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Shut down",
    );
    const restart = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Restart",
    );
    expect(shutdown?.disabled).toBe(true);
    expect(restart?.disabled).toBe(true);
  });
});
