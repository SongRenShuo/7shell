<script lang="ts">
/**
 * The backdrop ids the workbench knows how to draw, shared with the session editor that writes the
 * field. An id outside this list — and no id at all — draws the interface's own background, which
 * is what a document written before the field existed carries.
 */
export const WORKBENCH_WALLPAPER_IDS = ["aurora", "dawn", "forest", "plain"] as const;

export type WorkbenchWallpaperId = (typeof WORKBENCH_WALLPAPER_IDS)[number];
</script>

<script setup lang="ts">
/**
 * The desktop workbench: what a Linux desktop session opens as, instead of a terminal.
 *
 * This is an operating-system desktop, in the sense the reference product means: a status bar along
 * the top, a backdrop the session chose, a column of icons on it, a full-screen application starter,
 * floating windows that can be moved, resized, minimised and maximised, and a floating taskbar along
 * the bottom that holds what is open. Everything on the desktop is chrome over a picture — white
 * label, translucent dark plate — and does not follow the interface's light theme; the applications
 * inside the windows are ordinary interface surfaces and do.
 *
 * The windows are the workspace's own: a terminal is still a terminal tab underneath (the same open
 * order, the same handle, the same close), a file browser is the same browser the panels use, and
 * the system panel and the trash are the same components. What changes is where they are drawn, and
 * that is the whole point of a desktop — the thing you opened stays on this screen, in a frame you
 * can push around, instead of taking the tab strip away.
 *
 * The connection underneath is an ordinary SSH one, and every door leads somewhere that connection
 * already reaches. The one thing this desktop can ask the machine to *do* is the power action, and
 * it is asked about first: the buttons open the same plain confirmation every destructive action
 * here uses, and the acknowledgement that a person answered it is what travels with the command.
 */
import {
  ArrowUpDown,
  Boxes,
  Container,
  Cpu,
  ExternalLink,
  FileText,
  Folder,
  FolderPlus,
  Globe,
  HardDrive,
  House,
  Info,
  LayoutGrid,
  ListChecks,
  ListTree,
  Network,
  Power,
  RotateCw,
  Settings,
  Terminal,
  Trash2,
  X,
} from "@lucide/vue";
import type { Component } from "vue";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useI18n } from "vue-i18n";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import FileBrowser from "@/components/files/FileBrowser.vue";
import HostPage from "@/components/inspect/HostPage.vue";
import SystemReport from "@/components/inspect/SystemReport.vue";
import TerminalPane from "@/components/terminal/TerminalPane.vue";
import SystemPanel from "@/components/workspace/SystemPanel.vue";
import TrashWindow from "@/components/workspace/TrashWindow.vue";
import WorkbenchDockerWindow from "@/components/workspace/WorkbenchDockerWindow.vue";
import WorkbenchTransfersWindow from "@/components/workspace/WorkbenchTransfersWindow.vue";
import WorkbenchForwardsWindow from "@/components/workspace/WorkbenchForwardsWindow.vue";
import WorkbenchTailWindow from "@/components/workspace/WorkbenchTailWindow.vue";
import WorkbenchBatchWindow from "@/components/workspace/WorkbenchBatchWindow.vue";
import WorkbenchStarter from "@/components/workspace/WorkbenchStarter.vue";
import WorkbenchStatusBar from "@/components/workspace/WorkbenchStatusBar.vue";
import WorkbenchTaskbar from "@/components/workspace/WorkbenchTaskbar.vue";
import WorkbenchWidgets from "@/components/workspace/WorkbenchWidgets.vue";
import WorkbenchWindow from "@/components/workspace/WorkbenchWindow.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { useToast } from "@/composables/useToast";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import { describeShellError, type Translate } from "@/i18n/errors";
import { useFilesStore } from "@/stores/files";
import { clearIconOrder, moveIcon, normalizeIconOrder, readIconOrder, writeIconOrder } from "@/lib/workbench/iconOrder";
import { readHiddenDoors, writeHiddenDoors } from "@/lib/workbench/hiddenDoors";
import {
  WORKBENCH_WIDGET_IDS,
  readDesktopWidgets,
  writeDesktopWidgets,
  type WorkbenchWidgetId,
} from "@/lib/workbench/desktopWidgets";
import {
  addShortcut,
  isValidShortcutPath,
  readDesktopShortcuts,
  removeShortcut,
  shortcutName,
  writeDesktopShortcuts,
  type DesktopShortcut,
} from "@/lib/workbench/desktopIcons";
import {
  closeWindow as closeWindowRecord,
  focusWindow,
  minimizeAll,
  minimizeWindow,
  moveWindow,
  openWindow,
  resizeWindow,
  restoreAll,
  restoreWindow,
  setMaximized,
  showWindow,
  type WorkbenchBounds,
  type WorkbenchWindowState,
} from "@/lib/workbench/windows";
import type { MenuEntry } from "@/lib/menu/types";
import { sessionTabTitle } from "@/lib/sessions/reopen";
import { memorableRect, rememberedRect, writeWindowMemory } from "@/lib/workbench/windowMemory";
import {
  DEFAULT_DRAFT_COLOR,
  DEFAULT_DRAFT_OPACITY,
  encodeColor,
  encodeImage,
  fileToBackdrop,
  parseBackdrop,
  readStoredImage,
  writeStoredImage,
  type WorkbenchBackdrop,
} from "@/lib/workbench/wallpaperImage";
import { useTerminalsStore, type ContainerTab, type TerminalTab, type WorkbenchTab } from "@/stores/terminals";

const props = defineProps<{
  /** The tab this pane draws; its session is what everything here is about. */
  tab: WorkbenchTab;
  /** Whether this pane is the tab on screen. A hidden desktop reads nothing and ticks nothing. */
  active: boolean;
}>();

const { t, locale } = useI18n();
const terminals = useTerminalsStore();
const files = useFilesStore();
const { openMenu } = useContextMenu();
const { toast } = useToast();

function translate(key: string, params?: Record<string, string>): string {
  return params ? t(key, params) : t(key);
}

const session = computed(() => props.tab.session);
const connected = computed(() => props.tab.handle !== null && props.tab.failure === null);

/**
 * The backdrop the session asked for, or nothing for the interface's own background.
 *
 * An id this build does not draw is the same as no id: a document written elsewhere may carry a
 * name this version has never heard of, and guessing a picture would be drawing something the
 * person who saved it did not choose.
 */
const wallpaper = computed<WorkbenchBackdrop | undefined>(() => {
  const wanted = chosenWallpaper.value ?? session.value.workbench?.wallpaper ?? null;
  const parsed = parseBackdrop(wanted);
  // A picture whose bytes this device does not hold (the session moved, the storage refused) is
  // the interface's own background, not a picture with nothing behind the words: white chrome on
  // a light surface is the "nothing is legible" state the first release actually shipped.
  if (parsed?.kind === "image" && readStoredImage(session.value.id) === undefined) {
    return undefined;
  }
  return parsed;
});

/**
 * The backdrop chosen in this window, before the vault has been written back.
 *
 * Saving a session answers with the stored one, but the tab's own copy is what the desktop draws
 * from; keeping the choice here means the wallpaper changes the moment somebody picks it, and a
 * save that fails leaves the old one on screen rather than a lie.
 */
const chosenWallpaper = ref<string | null>(null);

/**
 * The backdrops, named in the workbench token block of `globals.css` rather than painted here: a
 * gradient is a colour decision, and the desktop's colour decisions live in one place now, where a
 * reskin finds all of them.
 */
const WALLPAPER_BACKDROPS: Readonly<Record<string, string>> = {
  aurora: "var(--workbench-wallpaper-aurora)",
  dawn: "var(--workbench-wallpaper-dawn)",
  forest: "var(--workbench-wallpaper-forest)",
  plain: "var(--workbench-wallpaper-plain)",
};

const wallpaperStyle = computed(() => {
  const shape = wallpaper.value;
  if (shape === undefined) {
    return undefined;
  }
  if (shape.kind === "gradient") {
    return { background: WALLPAPER_BACKDROPS[shape.id] };
  }
  if (shape.kind === "color") {
    return { background: shape.css };
  }
  const url = readStoredImage(session.value.id);
  if (url === undefined) {
    return undefined;
  }
  return {
    backgroundImage: `url(${url})`,
    backgroundSize: shape.fill,
    backgroundPosition: "center",
    backgroundRepeat: "no-repeat",
  };
});

/**
 * Whether the desktop is drawn on a picture rather than on the interface's own surface.
 *
 * It decides one thing, and it decides it for every icon: on a wallpaper the chrome stops
 * following the theme. A wallpaper is a picture — the gradients this build ships are all dark
 * washes, and a light theme's near-black labels on one of them are the "nothing is legible" state
 * the first release actually shipped. White with a soft shadow reads on all of them and needs no
 * per-wallpaper bookkeeping; on the plain surface the theme's own foreground is right, so that
 * path is unchanged.
 */
const onPicture = computed(() => wallpaper.value !== undefined);

// -- the desktop icons -------------------------------------------------------

/**
 * One icon on the desktop: what it is, what it says, and — for a shortcut — where it opens.
 *
 * The fixed ids carry a `system-` prefix, so a shortcut's own id can never collide with one of the
 * doors every desktop has.
 */
interface DesktopIcon {
  readonly id: string;
  readonly kind:
    | "home"
    | "terminal"
    | "monitor"
    | "systemInfo"
    | "system"
    | "trash"
    | "docker"
    | "transfers"
    | "forwards"
    | "tail"
    | "batch"
    | "shortcut";
  readonly label: string;
  readonly icon: Component;
  /** Drawn, but not openable: the placeholder is the whole of what it says. */
  readonly disabled?: boolean;
  /** Where a shortcut opens, when this icon is one. */
  readonly path?: string;
  /** The shortcut's own id in storage, which its removal is named by. */
  readonly shortcutId?: string;
}

/**
 * The doors this desktop has been set to hide, read out of the WebView's own storage when the
 * desktop is drawn — the same reasoning, and the same place, as the arrangement. Hiding takes the
 * door's icon off the grid and out of the starter and nothing else: the open paths behind the doors
 * stay intact, so putting a door back returns it to exactly where the arrangement says it goes.
 */
const hiddenDoors = ref<string[]>(readHiddenDoors(session.value.id));

/** Writes the choice down after the checkboxes have changed it. */
function persistHiddenDoors(): void {
  writeHiddenDoors(session.value.id, hiddenDoors.value);
}

/**
 * The widgets this desktop keeps on the desk, read out of the WebView's own storage when the
 * desktop is drawn — the same reasoning, and the same place, as the hidden doors. The set is
 * written whole whenever the settings' checkboxes change it.
 */
const widgetIds = ref<WorkbenchWidgetId[]>([...readDesktopWidgets(session.value.id)]);

function setWidget(id: WorkbenchWidgetId, on: boolean): void {
  const enabled = new Set(widgetIds.value);
  if (on) {
    enabled.add(id);
  } else {
    enabled.delete(id);
  }
  widgetIds.value = [...enabled];
  writeDesktopWidgets(session.value.id, enabled);
}

/**
 * The doors every desktop has, in the order the grid draws them, minus the ones this desktop hides.
 *
 * The monitor door and the system-information door lead to the same page on purpose: the readings
 * the first release drew on cards live on the monitor's system page, and both names are ways of
 * asking for it. Home and the trash are never hidden: a desktop without a home, or without a
 * trash, is not a desktop.
 */
const systemIcons = computed<DesktopIcon[]>(() => {
  const hidden = new Set(hiddenDoors.value);
  const doors: DesktopIcon[] = [
    { id: "system-home", kind: "home", label: t("workbench.desktop.icons.home"), icon: House },
    { id: "system-terminal", kind: "terminal", label: t("workbench.desktop.icons.terminal"), icon: Terminal },
    { id: "system-docker", kind: "docker", label: t("workbench.desktop.icons.docker"), icon: Container },
    { id: "system-monitor", kind: "monitor", label: t("workbench.desktop.icons.monitor"), icon: ListTree },
    { id: "system-info", kind: "systemInfo", label: t("workbench.desktop.icons.systemInfo"), icon: Info },
    { id: "system-panel", kind: "system", label: t("workbench.desktop.icons.system"), icon: Boxes },
    { id: "system-transfers", kind: "transfers", label: t("workbench.desktop.icons.transfers"), icon: ArrowUpDown },
    { id: "system-forwards", kind: "forwards", label: t("workbench.desktop.icons.forwards"), icon: Network },
    { id: "system-tail", kind: "tail", label: t("workbench.desktop.icons.tail"), icon: FileText },
    { id: "system-batch", kind: "batch", label: t("workbench.desktop.icons.batch"), icon: ListChecks },
    { id: "system-trash", kind: "trash", label: t("workbench.desktop.icons.trash"), icon: Trash2 },
  ];
  return doors.filter((icon) => !hidden.has(icon.id));
});

/**
 * The shortcuts this session's desktop carries, read out of the WebView's own storage when the
 * desktop is drawn. Losing them costs the shortcuts until they are added again, and nothing else
 * in the application reads them — the same reasoning, and the same place, as the recent paths.
 */
const shortcuts = ref<DesktopShortcut[]>(readDesktopShortcuts()[session.value.id] ?? []);

const userIcons = computed<DesktopIcon[]>(() =>
  shortcuts.value.map((shortcut) => ({
    id: `shortcut:${shortcut.id}`,
    kind: "shortcut" as const,
    label: shortcutName(shortcut.path),
    icon: Folder,
    path: shortcut.path,
    shortcutId: shortcut.id,
  })),
);

const defaultIcons = computed<DesktopIcon[]>(() => [...systemIcons.value, ...userIcons.value]);

/**
 * The arrangement somebody dragged into place, and the list the grid actually draws.
 *
 * The stored order is ids, not positions: an icon added later must not shift the ones after it.
 * `normalizeIconOrder` drops ids whose icon is gone and appends icons the order has not heard of,
 * which is what makes an older arrangement survive a new build.
 */
const iconOrder = ref<string[] | null>(readIconOrder(session.value.id));

const icons = computed<DesktopIcon[]>(() => {
  const all = defaultIcons.value;
  if (iconOrder.value === null) {
    return all;
  }
  const order = normalizeIconOrder(
    iconOrder.value,
    all.map((icon) => icon.id),
  );
  const byId = new Map(all.map((icon) => [icon.id, icon]));
  return order.flatMap((id) => {
    const icon = byId.get(id);
    return icon === undefined ? [] : [icon];
  });
});

/** The icon being dragged, and the icon it is currently over. */
const draggingId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);

function beginDrag(event: DragEvent, icon: DesktopIcon): void {
  if (icon.disabled) {
    event.preventDefault();
    return;
  }
  draggingId.value = icon.id;
  event.dataTransfer?.setData("text/plain", icon.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function dragOver(icon: DesktopIcon): void {
  if (draggingId.value !== null && draggingId.value !== icon.id) {
    dragOverId.value = icon.id;
  }
}

function dragOverDesktop(): void {
  dragOverId.value = null;
}

function endDrag(): void {
  draggingId.value = null;
  dragOverId.value = null;
}

/**
 * Measured budget (2026-11-19, `WorkbenchPane.perf.spec.ts`): on the fullest desktop the product
 * allows — 24 shortcuts over 11 doors — ten full drag sequences with hover stops run in ~70ms
 * total, and no icon element is remounted: the keyed list patches in place, so writing the whole
 * order array here and letting `icons` rebuild is comfortably inside budget. The spec stays in the
 * tree as the regression guard.
 */
function dropIcon(target: DesktopIcon | null): void {
  const dragged = draggingId.value;
  endDrag();
  if (dragged === null) {
    return;
  }
  const next = moveIcon(
    icons.value.map((icon) => icon.id),
    dragged,
    target?.id ?? null,
  );
  iconOrder.value = next;
  writeIconOrder(session.value.id, next);
}

function resetIconOrder(): void {
  clearIconOrder(session.value.id);
  iconOrder.value = null;
}

/** The icon somebody has clicked, which the Enter key opens and a click on the wallpaper clears. */
const selectedId = ref<string | null>(null);

// -- the windows -------------------------------------------------------------

/**
 * What a window carries beyond its rectangle: the tab a terminal window holds, and the place a file
 * window opened onto.
 *
 * The rectangle arithmetic lives in `lib/workbench/windows` and knows nothing about either, which is
 * why the window record's `kind` is a plain string and this record is the caller's own vocabulary.
 */
interface WindowPayload {
  readonly tabId?: string;
  /** The SFTP browser the window draws, once `files.open` answered with one. */
  readonly fileHandle?: string;
  readonly path?: string;
}

const windows = ref<WorkbenchWindowState[]>([]);
const payloads = ref<Record<string, WindowPayload>>({});

/** The work area — everything between the status bar and the taskbar — as the geometry's frame. */
const workArea = ref<HTMLElement | null>(null);
const bounds = ref<WorkbenchBounds>({ width: 1024, height: 700 });
let areaObserver: ResizeObserver | undefined;

function measure(): void {
  const element = workArea.value;
  if (element === null) {
    return;
  }
  bounds.value = { width: element.clientWidth, height: element.clientHeight };
}

/**
 * Keeps a maximised window filling the desk when the desk itself changes size.
 *
 * `setMaximized` deliberately does nothing to a window that is already maximised, so the library's
 * geometry stays whatever it was when the button was pressed. The shell owns the live rectangle,
 * and a window resized by the person dragging the application's edge should still fill it.
 */
watch(bounds, (next) => {
  if (!windows.value.some((window) => window.mode === "max")) {
    return;
  }
  windows.value = windows.value.map((window) =>
    window.mode === "max" ? { ...window, left: 0, top: 0, width: next.width, height: next.height } : window,
  );
});

/**
 * Opens a window, or raises the one already carrying this id.
 *
 * A desktop's applications are mostly single-instance — the machine's system panel is one place,
 * not several — so the id is the caller's decision about that: the fixed surfaces use a fixed id,
 * and the ones a person may want twice (a file browser onto two directories) carry a fresh one.
 */
function openRecord(id: string, title: string, kind: string, payload: WindowPayload = {}): void {
  measure();
  // A window comes back to where its kind was last left on this machine, clamped into the desk as
  // it is now; a kind never opened here opens centred at the default.
  const remembered = rememberedRect(session.value.id, kind, bounds.value);
  windows.value = openWindow(windows.value, { id, title, kind, bounds: bounds.value, remembered });
  if (payload.tabId !== undefined || payload.path !== undefined || payload.fileHandle !== undefined) {
    payloads.value = { ...payloads.value, [id]: payload };
  }
}

/**
 * Writes each visible window's geometry down, 100ms after the last change settles.
 *
 * A drag produces a move per pointer step; without the debounce that is a storage write per frame.
 * A maximised window writes where it restores to, not the desk it covers, so reopening the kind
 * lands where the person actually kept it. Kinds share one memory slot — a desktop holding two file
 * windows writes the same slot twice, and the last writer wins, which is the memory's own rule.
 */
let memoryFlushTimer: ReturnType<typeof setTimeout> | undefined;

watch(windows, () => {
  if (memoryFlushTimer !== undefined) {
    clearTimeout(memoryFlushTimer);
  }
  memoryFlushTimer = setTimeout(() => {
    memoryFlushTimer = undefined;
    for (const window of windows.value) {
      const rect = memorableRect(window);
      if (rect !== undefined) {
        writeWindowMemory(session.value.id, window.kind, rect);
      }
    }
  }, 100);
});

function focus(id: string): void {
  windows.value = focusWindow(windows.value, id);
}

function minimize(id: string): void {
  windows.value = minimizeWindow(windows.value, id);
}

function maximize(id: string): void {
  windows.value = setMaximized(windows.value, id, bounds.value);
}

function restore(id: string): void {
  windows.value = restoreWindow(windows.value, id);
}

function move(id: string, next: { left: number; top: number }): void {
  windows.value = moveWindow(windows.value, id, next, bounds.value);
}

function resize(id: string, next: { width: number; height: number }): void {
  windows.value = resizeWindow(windows.value, id, next, bounds.value);
}

function raise(id: string): void {
  windows.value = showWindow(windows.value, id);
}

/**
 * Closes a window and, when it was holding a terminal, the tab underneath it.
 *
 * The close is drawn before it happens: the record keeps its place for the 200ms the collapse
 * animation runs, and only then is removed together with everything it holds. A window that
 * vanished between one frame and the next reads as a crash; a window that folds away reads as
 * something somebody closed.
 *
 * The window is the tab's surface here, so a closed window that left a connection running would be
 * a connection nobody can see or close. A terminal that ended is still a tab — it is where its
 * reason and its reconnect live — so this closes it through the store like any other tab.
 */
const CLOSING_MS = 220;
const closingIds = ref<string[]>([]);

function close(id: string): void {
  if (closingIds.value.includes(id)) {
    return;
  }
  closingIds.value = [...closingIds.value, id];
  setTimeout(() => {
    closingIds.value = closingIds.value.filter((entry) => entry !== id);
    const payload = payloads.value[id];
    windows.value = closeWindowRecord(windows.value, id);
    const next = { ...payloads.value };
    delete next[id];
    payloads.value = next;
    if (payload?.tabId !== undefined) {
      terminals.closeTab(payload.tabId);
    }
    if (payload?.fileHandle !== undefined) {
      // The browser was this window's own; closing it is what releases the channel it opened.
      void files.close(payload.fileHandle);
    }
  }, CLOSING_MS);
}

const windowLabels = computed(() => ({
  minimize: t("workbench.desktop.shell.minimize"),
  maximize: t("workbench.desktop.shell.maximize"),
  restore: t("workbench.desktop.shell.restore"),
  close: t("workbench.desktop.shell.close"),
}));

function terminalOf(id: string): TerminalTab | null {
  const tabId = payloads.value[id]?.tabId;
  if (tabId === undefined) {
    return null;
  }
  const tab = terminals.tabs.find((entry) => entry.id === tabId);
  return tab?.kind === "terminal" ? tab : null;
}

/** The handle a terminal window draws, or null while there is no shell to draw. */
function terminalHandle(id: string): string | null {
  return terminalOf(id)?.handle ?? null;
}

/** The container tab a Docker window carries, or null before its open answered. */
function dockerTabOf(id: string): ContainerTab | null {
  const tabId = payloads.value[id]?.tabId;
  if (tabId === undefined) {
    return null;
  }
  const tab = terminals.tabs.find((entry) => entry.id === tabId);
  return tab?.kind === "container" ? tab : null;
}

/** Whether the terminal a window holds can still take keystrokes. */
function terminalInteractive(id: string): boolean {
  return terminalOf(id)?.status === "open";
}

/** Asks the store to reconnect the terminal under a window, which is its tab's own offer. */
function reconnectWindow(id: string): void {
  const tab = terminalOf(id);
  if (tab !== null) {
    terminals.reconnect(tab.id);
  }
}

function homeOf(id: string): string | undefined {
  return payloads.value[id]?.path;
}

/** The SFTP browser a file window draws, or null before its open answered. */
function fileHandleOf(id: string): string | null {
  return payloads.value[id]?.fileHandle ?? null;
}

/** The window icon, drawn beside its title: the same door the desktop icon draws. */
function iconOf(kind: string): Component {
  switch (kind) {
    case "terminal":
      return Terminal;
    case "files":
      return Folder;
    case "monitor":
      return Cpu;
    case "system":
      return HardDrive;
    case "docker":
      return Container;
    case "transfers":
      return ArrowUpDown;
    case "forwards":
      return Network;
    case "tail":
      return FileText;
    case "batch":
      return ListChecks;
    case "trash":
      return Trash2;
    default:
      return Globe;
  }
}

/**
 * The colour of an icon's plate.
 *
 * The reference desktop's icons are app stickers — a coloured square with a bright glyph — rather
 * than line drawings, and a plate is what gives a lucide glyph the same weight at desktop size
 * without copying the reference's artwork. One tone per door, the same in the grid, the starter and
 * the taskbar, so the same application is the same colour wherever it is named.
 */
function toneOf(kind: string): string {
  switch (kind) {
    case "terminal":
      return "bg-emerald-500/90";
    case "files":
    case "home":
    case "shortcut":
      return "bg-amber-500/90";
    case "monitor":
    case "systemInfo":
      return "bg-sky-500/90";
    case "system":
      return "bg-violet-500/90";
    case "docker":
      return "bg-sky-600/90";
    case "transfers":
      return "bg-cyan-600/90";
    case "forwards":
      return "bg-indigo-600/90";
    case "tail":
      return "bg-teal-600/90";
    case "batch":
      return "bg-orange-600/90";
    case "trash":
      return "bg-rose-500/90";
    default:
      return "bg-slate-500/90";
  }
}

// -- opening things ----------------------------------------------------------

function select(icon: DesktopIcon): void {
  selectedId.value = icon.id;
}

function clearSelection(): void {
  selectedId.value = null;
}

/**
 * Opens what an icon names, in a window on this desktop.
 *
 * A path handed to the file browser is a place to be: the window opens there, and the browser's own
 * navigation walks from it — the same browser the panels use, with the workbench's connection under
 * it, so nothing is opened twice and no connection is made for a window.
 */
function openIcon(icon: DesktopIcon): void {
  if (icon.disabled) {
    return;
  }
  selectedId.value = icon.id;
  switch (icon.kind) {
    case "home":
      void openFilesWindow(undefined, t("workbench.desktop.icons.home"));
      return;
    case "terminal":
      void openTerminalWindow();
      return;
    // Two names, one destination: see `systemIcons`.
    case "monitor":
    case "systemInfo":
      openRecord("monitor", t("workbench.desktop.icons.monitor"), "monitor");
      return;
    case "system":
      openRecord("system", t("workbench.desktop.icons.system"), "system");
      return;
    case "docker":
      void openDockerWindow();
      return;
    case "transfers":
      openRecord("transfers", t("workbench.desktop.icons.transfers"), "transfers");
      return;
    case "forwards":
      openRecord("forwards", t("workbench.desktop.icons.forwards"), "forwards");
      return;
    case "tail":
      openRecord("tail", t("workbench.desktop.icons.tail"), "tail");
      return;
    case "batch":
      openRecord("batch", t("workbench.desktop.icons.batch"), "batch");
      return;
    case "trash":
      openRecord("trash", t("workbench.desktop.icons.trash"), "trash");
      return;
    case "shortcut":
      void openFilesWindow(icon.path, icon.label);
      return;
  }
}

/**
 * Opens the Docker manager.
 *
 * The engine is the machine's own Docker, reached over the connection this desktop already holds —
 * `desktop_engine_open` in the core, on the same carrier the trash and the file windows use. The
 * tab underneath is an ordinary container tab marked windowed, so the strip leaves it here and
 * closing the window closes the engine with it.
 */
async function openDockerWindow(): Promise<void> {
  const tabId = await terminals.openContainerTab(session.value, { windowed: true });
  if (tabId === null) {
    return;
  }
  openRecord(`docker:${tabId}`, t("workbench.desktop.icons.docker"), "docker", { tabId });
}

/**
 * Opens a file browser in a window, on a browser of its own.
 *
 * The workbench's own connection is not an SFTP browser: the file surfaces are handed a *browser*
 * handle, which is what `files.open` creates. So a window asks for one, the way a files tab does,
 * and keeps it until the window closes — the listing, the editor and the transfers all hang off
 * that handle, and a window that borrowed another surface's would close it from under that surface.
 */
async function openFilesWindow(path: string | undefined, title: string): Promise<void> {
  if (props.tab.handle === null) {
    return;
  }
  const outcome = await files.open(session.value.id);
  if (outcome.kind !== "opened") {
    // A host-key decision is the store's to raise and the workspace's to show; there is no window
    // to draw until it is answered.
    return;
  }
  openRecord(`files:${crypto.randomUUID()}`, title, "files", { path, fileHandle: outcome.handle });
}

/**
 * Opens a terminal window.
 *
 * The tab is asked for first: the window draws a tab, so a window opened before there is one would
 * be an empty frame. A refused open — a host key still being decided, a connection that failed —
 * produces no tab and therefore no window, and the store has already said why.
 */
async function openTerminalWindow(): Promise<void> {
  const tabId = await terminals.openTerminalTab(session.value, { windowed: true });
  if (tabId === null) {
    return;
  }
  openRecord(`terminal:${tabId}`, sessionTabTitle(session.value.name, terminals.copyOf(tabId)), "terminal", { tabId });
}

// -- the starter -------------------------------------------------------------

const starterOpen = ref(false);

interface StarterApp {
  readonly id: string;
  readonly label: string;
  readonly icon: Component;
  readonly tone: string;
}

/**
 * The applications the starter offers: the same doors the desktop has, minus the ones it hides, plus
 * the settings. A door hidden from the grid is hidden from the sheet too — two places saying one
 * thing is a lie about the desktop, whichever of them is looked at.
 */
const starterApps = computed<StarterApp[]>(() => {
  const hidden = new Set(hiddenDoors.value);
  return [
    { id: "home", label: t("workbench.desktop.icons.home"), icon: House, tone: "bg-amber-500/85" },
    { id: "terminal", label: t("workbench.desktop.icons.terminal"), icon: Terminal, tone: "bg-emerald-500/85" },
    { id: "docker", label: t("workbench.desktop.icons.docker"), icon: Container, tone: "bg-sky-600/85" },
    { id: "monitor", label: t("workbench.desktop.icons.monitor"), icon: ListTree, tone: "bg-sky-500/85" },
    { id: "system", label: t("workbench.desktop.icons.system"), icon: Boxes, tone: "bg-violet-500/85" },
    { id: "transfers", label: t("workbench.desktop.icons.transfers"), icon: ArrowUpDown, tone: "bg-cyan-600/85" },
    { id: "forwards", label: t("workbench.desktop.icons.forwards"), icon: Network, tone: "bg-indigo-600/85" },
    { id: "tail", label: t("workbench.desktop.icons.tail"), icon: FileText, tone: "bg-teal-600/85" },
    { id: "batch", label: t("workbench.desktop.icons.batch"), icon: ListChecks, tone: "bg-orange-600/85" },
    { id: "trash", label: t("workbench.desktop.icons.trash"), icon: Trash2, tone: "bg-rose-500/85" },
    { id: "settings", label: t("workbench.desktop.menu.settings"), icon: Settings, tone: "bg-slate-500/85" },
  ].filter((app) => !hidden.has(`system-${app.id}`));
});

function launch(appId: string): void {
  starterOpen.value = false;
  switch (appId) {
    case "home":
      void openFilesWindow(undefined, t("workbench.desktop.icons.home"));
      return;
    case "terminal":
      void openTerminalWindow();
      return;
    case "docker":
      void openDockerWindow();
      return;
    case "monitor":
      openRecord("monitor", t("workbench.desktop.icons.monitor"), "monitor");
      return;
    case "system":
      openRecord("system", t("workbench.desktop.icons.system"), "system");
      return;
    case "transfers":
      openRecord("transfers", t("workbench.desktop.icons.transfers"), "transfers");
      return;
    case "forwards":
      openRecord("forwards", t("workbench.desktop.icons.forwards"), "forwards");
      return;
    case "tail":
      openRecord("tail", t("workbench.desktop.icons.tail"), "tail");
      return;
    case "batch":
      openRecord("batch", t("workbench.desktop.icons.batch"), "batch");
      return;
    case "trash":
      openRecord("trash", t("workbench.desktop.icons.trash"), "trash");
      return;
    case "settings":
      settingsOpen.value = true;
      return;
  }
}

// -- the taskbar -------------------------------------------------------------

interface TaskbarEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: Component;
  /** The plate behind the icon, the same tone the desktop grid gives that door. */
  readonly tone: string;
  readonly active: boolean;
}

/**
 * The taskbar's cells: one per window, in the order the windows were opened.
 *
 * Minimised windows keep their cell — that is what a taskbar is for — and the dot under the icon
 * says which one is in front. The window ids are the cell ids, so pressing a cell raises exactly
 * the window it names.
 */
const taskbarEntries = computed<TaskbarEntry[]>(() =>
  windows.value
    // A window that is folding away has left the bar already: the cell and the animation would
    // disagree about whether the thing still exists, and the bar is the faster read of the two.
    .filter((window) => !closingIds.value.includes(window.id))
    .map((window) => ({
      id: window.id,
      label: window.title,
      icon: iconOf(window.kind),
      tone: toneOf(window.kind),
      active: window.focused && window.mode !== "min",
    })),
);

function pressTaskbar(id: string): void {
  raise(id);
}

/**
 * The desktop button: empty the desk, or bring everything back.
 *
 * The button is a toggle between two desk-wide states, decided by what is on screen now — a desk
 * with a visible window empties itself; an empty desk (every window put away) brings the windows
 * back. That is the whole behaviour the launch docks teach, and it needs no state of its own: the
 * windows are the state.
 */
function pressDesktop(): void {
  windows.value = windows.value.some((window) => window.mode !== "min")
    ? minimizeAll(windows.value)
    : restoreAll(windows.value);
}

/**
 * Opens the window a widget points at: the vitals cards want the monitor's system page, and the
 * storage card wants the system panel's disk tree — the two places those readings become an answer.
 */
function openWidgetTarget(target: "monitor" | "system"): void {
  if (target === "monitor") {
    openRecord("monitor", t("workbench.desktop.icons.monitor"), "monitor");
    return;
  }
  openRecord("system", t("workbench.desktop.icons.system"), "system");
}

// -- the clock ---------------------------------------------------------------

/**
 * The time the taskbar shows, refreshed once a minute.
 *
 * One interval, started when the pane is drawn and cleared when it goes: a clock that kept ticking
 * behind a closed tab would be this window paying for a reading nobody can see. A minute is the
 * whole resolution of what the bar says, so nothing faster would be visible anyway.
 */
const now = ref(new Date());
let clockTicker: ReturnType<typeof setInterval> | undefined;

onMounted(() => {
  measure();
  if (typeof ResizeObserver !== "undefined" && workArea.value !== null) {
    areaObserver = new ResizeObserver(() => measure());
    areaObserver.observe(workArea.value);
  }
  clockTicker = setInterval(() => {
    now.value = new Date();
  }, 60_000);
});

onUnmounted(() => {
  if (clockTicker !== undefined) {
    clearInterval(clockTicker);
    clockTicker = undefined;
  }
  if (memoryFlushTimer !== undefined) {
    clearTimeout(memoryFlushTimer);
    memoryFlushTimer = undefined;
  }
  areaObserver?.disconnect();
  areaObserver = undefined;
});

/** The hour and minute, in the interface's language: 24-hour, because that is what a log reads. */
const clockTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, { hour: "2-digit", minute: "2-digit", hour12: false }).format(now.value),
);

/** The date, shown only when the bar has room for it — the month and day a desktop clock adds. */
const clockDate = computed(() =>
  new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric" }).format(now.value),
);

// -- the menus ---------------------------------------------------------------

function persistShortcuts(): void {
  writeDesktopShortcuts({ ...readDesktopShortcuts(), [session.value.id]: shortcuts.value });
}

/**
 * What the wallpaper offers when it is right-clicked.
 *
 * Refresh re-reads what storage holds — the icons are memory, not a live view of the machine, so
 * that is the whole of what refreshing can mean. Reset layout forgets the arrangement this session
 * was left in. The settings entry opens the desktop's own two choices: a backdrop and a density.
 */
function openDesktopMenu(event: MouseEvent): void {
  openMenu(
    event,
    { key: "workbench.desktop.title" },
    [
      {
        kind: "action",
        id: "desktop-refresh",
        labelKey: "workbench.desktop.menu.refresh",
        icon: RotateCw,
        run: refreshDesktop,
      },
      {
        kind: "action",
        id: "desktop-new-shortcut",
        labelKey: "workbench.desktop.menu.newShortcut",
        icon: FolderPlus,
        run: beginCreateShortcut,
      },
      {
        kind: "action",
        id: "desktop-reset-layout",
        labelKey: "workbench.desktop.menu.resetLayout",
        icon: LayoutGrid,
        run: resetIconOrder,
      },
      {
        kind: "action",
        id: "desktop-settings",
        labelKey: "workbench.desktop.menu.settings",
        icon: Settings,
        run: () => {
          settingsOpen.value = true;
        },
      },
    ],
    { tone: "desktop" },
  );
}

function refreshDesktop(): void {
  shortcuts.value = readDesktopShortcuts()[session.value.id] ?? [];
  selectedId.value = null;
}

/** What an icon offers when it is right-clicked: the door, its removal, and what it is. */
function openIconMenu(event: MouseEvent, icon: DesktopIcon): void {
  if (icon.disabled) {
    return;
  }
  const entries: MenuEntry[] = [
    {
      kind: "action",
      id: "icon-open",
      labelKey: "workbench.desktop.menu.open",
      icon: ExternalLink,
      run: () => openIcon(icon),
    },
  ];
  if (icon.kind === "shortcut") {
    entries.push({
      kind: "action",
      id: "icon-remove",
      labelKey: "workbench.desktop.menu.remove",
      icon: X,
      run: () => removeIcon(icon),
    });
  }
  entries.push({ kind: "separator", id: "icon-sep" });
  entries.push({
    kind: "action",
    id: "icon-properties",
    labelKey: "workbench.desktop.menu.properties",
    icon: Info,
    run: () => {
      propertiesIcon.value = icon;
    },
  });
  openMenu(event, { key: "workbench.desktop.title" }, entries, { tone: "desktop" });
}

function removeIcon(icon: DesktopIcon): void {
  if (icon.shortcutId === undefined) {
    return;
  }
  shortcuts.value = removeShortcut(shortcuts.value, icon.shortcutId);
  persistShortcuts();
  if (selectedId.value === icon.id) {
    selectedId.value = null;
  }
}

// -- adding a shortcut -------------------------------------------------------

const creating = ref(false);
const draftPath = ref("");

function beginCreateShortcut(): void {
  draftPath.value = "";
  creating.value = true;
}

const draftValid = computed(() => isValidShortcutPath(draftPath.value));

function cancelCreateShortcut(): void {
  creating.value = false;
}

/**
 * Puts the typed path on the desktop and writes the arrangement down.
 *
 * The list's own rules decide what a duplicate and a full desktop mean; the dialog only refuses to
 * send a path the input rules would reject, which is why the confirm button is out of reach while
 * the draft is not a path.
 */
function createShortcut(): void {
  if (!draftValid.value) {
    return;
  }
  shortcuts.value = addShortcut(shortcuts.value, draftPath.value, crypto.randomUUID());
  persistShortcuts();
  creating.value = false;
}

// -- the desktop's own settings ----------------------------------------------

const settingsOpen = ref(false);

/**
 * The icon whose properties are on screen, or null.
 *
 * A desktop's "Properties" is a read-only card: what the thing is called, what kind of thing it is,
 * and — for a shortcut — the path it opens. It also carries the two actions that only make sense
 * from here: copying that path, and removing the shortcut from this desktop. A system door has
 * neither: it is not somebody's to copy away or delete.
 */
const propertiesIcon = ref<DesktopIcon | null>(null);

/** What a door opens, as a key: one sentence per kind, rather than one per icon. */
function propertiesOpensKey(icon: DesktopIcon): string {
  return `workbench.desktop.properties.opens.${icon.kind === "systemInfo" ? "monitor" : icon.kind}`;
}

/** Puts a shortcut's path on the clipboard, and says which of the two things happened. */
async function copyPropertiesPath(icon: DesktopIcon): Promise<void> {
  if (icon.path === undefined) {
    return;
  }
  try {
    await navigator.clipboard.writeText(icon.path);
    toast(t("workbench.desktop.properties.copied"), "receipt");
  } catch {
    toast(t("workbench.desktop.properties.copyFailed"), "failure");
  }
}

/** Takes the properties of a shortcut away with the shortcut itself. */
function removeFromProperties(icon: DesktopIcon): void {
  propertiesIcon.value = null;
  removeIcon(icon);
}

const ICON_DENSITY_KEY = "sevenshell-workbench-density";

/**
 * How large an icon cell is drawn.
 *
 * The reference desktop's cell is 85px with a 40px picture; compact is the same grid with less air,
 * for a small window. It is a preference of this window rather than of the session: two monitors
 * showing different machines may be different sizes.
 */
const iconDensity = ref<"comfortable" | "compact">(
  (() => {
    try {
      return localStorage.getItem(ICON_DENSITY_KEY) === "compact" ? "compact" : "comfortable";
    } catch {
      return "comfortable";
    }
  })(),
);

function setDensity(next: "comfortable" | "compact"): void {
  iconDensity.value = next;
  try {
    localStorage.setItem(ICON_DENSITY_KEY, next);
  } catch {
    // A WebView that refuses storage costs the preference, not the desktop.
  }
}

const TASKBAR_ALIGN_KEY = "sevenshell-workbench-taskbar-align";

/**
 * Where the taskbar sits: at the reference's insets on either side, or shrunk to its contents and
 * centred. A preference of this window rather than of the session, like the density above it.
 */
const taskbarAlign = ref<"left" | "center">(
  (() => {
    try {
      return localStorage.getItem(TASKBAR_ALIGN_KEY) === "center" ? "center" : "left";
    } catch {
      return "left";
    }
  })(),
);

function setTaskbarAlign(next: "left" | "center"): void {
  taskbarAlign.value = next;
  try {
    localStorage.setItem(TASKBAR_ALIGN_KEY, next);
  } catch {
    // A WebView that refuses storage costs the preference, not the desktop.
  }
}

/**
 * The doors the settings may hide, as the icon-grid ids that name them and the icon names they go
 * by. The storage module owns the canonical list; this is the names the dialog draws beside their
 * checkboxes.
 */
const HIDEABLE_DOOR_LABEL_KEYS: Readonly<Record<string, string>> = {
  "system-terminal": "terminal",
  "system-docker": "docker",
  "system-monitor": "monitor",
  "system-info": "systemInfo",
  "system-panel": "system",
  "system-transfers": "transfers",
  "system-forwards": "forwards",
  "system-tail": "tail",
  "system-batch": "batch",
};

async function chooseWallpaper(id: string | null): Promise<void> {
  chosenWallpaper.value = id;
  try {
    const saved = await backend.sessions.save({
      ...session.value,
      workbench: { ...session.value.workbench, wallpaper: id ?? undefined },
    });
    if ((saved.workbench?.wallpaper ?? null) !== id) {
      chosenWallpaper.value = null;
    }
  } catch (error) {
    const failure = asShellError(error, "session_save");
    toast(describeShellError(translate as Translate, failure).message, "failure");
    chosenWallpaper.value = null;
  }
}

/** The colour and opacity the settings' colour row is drafting; applying encodes both. */
const draftColor = ref(DEFAULT_DRAFT_COLOR);
const draftOpacity = ref(DEFAULT_DRAFT_OPACITY);

function applyColor(): void {
  const value = encodeColor(draftColor.value, draftOpacity.value);
  if (value !== undefined) {
    void chooseWallpaper(value);
  }
}

/**
 * Turns a picked file into this desk's picture and makes the session carry the decision.
 *
 * The bytes are scaled and encoded first — a refused save must not leave the vault carrying a
 * decision the picture cannot honour — and the picture lands in this device's storage, keyed by
 * session. A pick the browser cannot decode is said, not swallowed.
 */
async function chooseImage(file: File): Promise<void> {
  try {
    const url = await fileToBackdrop(file);
    writeStoredImage(session.value.id, url);
    await chooseWallpaper(encodeImage("cover"));
  } catch {
    toast(t("workbench.desktop.settings.imageFailed"), "failure");
  }
}

/** Changes how the picture fills the desk, on the session's own string. */
function setBackdropFill(fill: "cover" | "contain"): void {
  void chooseWallpaper(encodeImage(fill));
}

/** Takes the picture off this device and puts the session back on the plain surface. */
function removeImage(): void {
  writeStoredImage(session.value.id, undefined);
  void chooseWallpaper(null);
}

/** Whether the settings' image row is the backdrop the session currently wears. */
const backdropIsImage = computed(() => wallpaper.value?.kind === "image");

// -- the power actions -------------------------------------------------------

const confirming = ref<"reboot" | "shutdown" | null>(null);

function confirmTitle(): string {
  return confirming.value === "reboot"
    ? t("workbench.power.rebootTitle", { name: session.value.name })
    : t("workbench.power.shutdownTitle", { name: session.value.name });
}

function confirmMessage(): string {
  return confirming.value === "reboot" ? t("workbench.power.rebootMessage") : t("workbench.power.shutdownMessage");
}

function confirmLabel(): string {
  return confirming.value === "reboot" ? t("workbench.power.rebootConfirm") : t("workbench.power.shutdownConfirm");
}

/**
 * Carries out what the confirmation was about, once somebody has answered it.
 *
 * The answer is the acknowledgement the policy gate acts on, which is why the call carries `true`
 * rather than a question: asking again would be asking twice about one answer. A machine that took
 * the connection down with it has had the command work, not fail — the backend answers that — so
 * the receipt here is only for a command that left.
 */
async function issuePower(): Promise<void> {
  const action = confirming.value;
  if (!action || props.tab.handle === null) {
    confirming.value = null;
    return;
  }
  confirming.value = null;
  try {
    await backend.workbenchPower(session.value.id, props.tab.handle, action, true);
    toast(t("workbench.power.issued"), "receipt");
  } catch (error) {
    const failure = asShellError(error, "workbench_power");
    toast(describeShellError(translate as Translate, failure).message, "failure");
  }
}

/**
 * Opens the power menu at the taskbar's end.
 *
 * The bar hands over no pointer coordinate — it is a strip of buttons, and the reference product's
 * power control opens at the same place every time. The synthetic position is the bottom-right
 * corner, which is where this menu is drawn from; the menu itself does the hit-testing.
 */
function openPowerMenu(): void {
  const at = {
    clientX: window.innerWidth - 24,
    clientY: window.innerHeight - 24,
    preventDefault: () => {},
    stopPropagation: () => {},
  } as unknown as MouseEvent;
  openMenu(
    at,
    { key: "workbench.power.title" },
    [
      {
        kind: "action",
        id: "power-reboot",
        labelKey: "workbench.power.reboot",
        icon: RotateCw,
        disabled: !connected.value,
        run: () => {
          confirming.value = "reboot";
        },
      },
      {
        kind: "action",
        id: "power-shutdown",
        labelKey: "workbench.power.shutdown",
        icon: Power,
        danger: true,
        disabled: !connected.value,
        run: () => {
          confirming.value = "shutdown";
        },
      },
    ],
    { tone: "desktop" },
  );
}

/**
 * Disconnects this desktop: closing the workbench tab closes the connection under it, which is what
 * the status bar's power button does. It is a real close, and the session is reachable again from
 * the sidebar like any other.
 */
function disconnect(): void {
  terminals.closeTab(props.tab.id);
}
</script>

<template>
  <section
    class="relative flex min-h-0 flex-1 flex-col overflow-hidden"
    :class="wallpaper === undefined ? 'bg-background' : undefined"
    :style="wallpaperStyle"
    data-workbench-shell
  >
    <WorkbenchStatusBar
      :host="session.host"
      :user="session.user"
      :clock="`${clockTime} · ${clockDate}`"
      :connected="connected"
      :labels="{ disconnect: t('workbench.desktop.shell.disconnect') }"
      @disconnect="disconnect()"
    />

    <div
      ref="workArea"
      class="relative z-0 min-h-0 flex-1 overflow-hidden"
      @click="clearSelection()"
      @contextmenu="openDesktopMenu"
      @dragover.prevent="dragOverDesktop()"
      @drop.prevent="dropIcon(null)"
    >
      <!--
        The desktop: the icons from the top left, and nothing else on it. A click on the wallpaper
        clears the selection, because on a desktop that is what clicking nowhere means; an icon
        stops the click on its way up. A drop on the wallpaper is where a dragged icon goes when it
        is not dropped onto another one: the end of the grid.
      -->
      <div data-workbench-desktop class="absolute inset-0 overflow-y-auto">
        <div
          class="grid content-start justify-start gap-1 p-2"
          :class="
            iconDensity === 'compact' ? 'grid-cols-[repeat(auto-fill,4.5rem)]' : 'grid-cols-[repeat(auto-fill,5.5rem)]'
          "
          data-workbench-icons
        >
          <button
            v-for="icon in icons"
            :key="icon.id"
            type="button"
            data-workbench-icon
            :data-icon-id="icon.id"
            :disabled="icon.disabled"
            draggable="true"
            :title="icon.disabled ? t('workbench.desktop.iconUnavailable') : undefined"
            class="flex h-[5.25rem] w-[5.25rem] flex-col items-center justify-start gap-1.5 rounded-lg px-1 py-2 text-center transition duration-150 active:scale-[0.96]"
            :class="[
              onPicture
                ? selectedId === icon.id
                  ? 'bg-white/20 text-white'
                  : 'text-white/95 hover:bg-white/10'
                : selectedId === icon.id
                  ? 'bg-accent text-foreground'
                  : 'text-foreground hover:bg-accent/50',
              dragOverId === icon.id ? (onPicture ? 'ring-2 ring-white/70' : 'ring-2 ring-primary/60') : undefined,
            ]"
            @click.stop="select(icon)"
            @dblclick.stop="openIcon(icon)"
            @keydown.enter.prevent="openIcon(icon)"
            @contextmenu.stop="openIconMenu($event, icon)"
            @dragstart.stop="beginDrag($event, icon)"
            @dragover.prevent.stop="dragOver(icon)"
            @drop.stop.prevent="dropIcon(icon)"
            @dragend="endDrag()"
          >
            <!--
              The picture sits on a coloured plate: the reference desktop's icons are app stickers,
              not line drawings, and a coloured tile is what gives a lucide glyph the same weight at
              desktop size without copying any of its artwork.
            -->
            <span
              class="grid size-10 shrink-0 place-items-center rounded-[0.6rem] text-white shadow-[0_2px_6px_rgba(0,0,0,0.35)]"
              :class="toneOf(icon.kind)"
            >
              <component :is="icon.icon" :size="22" :stroke-width="1.8" />
            </span>
            <span
              class="w-full truncate text-[13px] leading-tight"
              :class="onPicture ? '[text-shadow:var(--wb-shadow-text-picture)]' : undefined"
              >{{ icon.label }}</span
            >
          </button>
        </div>
      </div>

      <!--
        The widgets column, on the desk's right edge: the machine's vitals, each card a button into
        the window that can explain its readings. It samples only while this desktop is the tab on
        screen, and the component itself also asks whether the application window is visible.
      -->
      <WorkbenchWidgets
        v-if="connected"
        :handle="tab.handle"
        :active="active"
        :enabled="widgetIds"
        @open="openWidgetTarget($event)"
      />

      <!--
        The windows, in the order the store keeps them. A window is drawn while it exists, whether it
        is minimised or not: the component scales it away, so a terminal keeps its screen and its
        scrollback rather than being torn down and rebuilt.
      -->
      <WorkbenchWindow
        v-for="window in windows"
        :key="window.id"
        :id="window.id"
        :title="window.title"
        :icon="iconOf(window.kind)"
        :state="window.mode"
        :focused="window.focused"
        :left="window.left"
        :top="window.top"
        :width="window.width"
        :height="window.height"
        :closing="closingIds.includes(window.id)"
        :labels="windowLabels"
        :style="{ zIndex: window.z }"
        class="absolute"
        @contextmenu.stop
        @focus="focus(window.id)"
        @close="close(window.id)"
        @minimize="minimize(window.id)"
        @maximize="maximize(window.id)"
        @restore="restore(window.id)"
        @move="move(window.id, $event)"
        @resize="resize(window.id, $event)"
      >
        <!-- The terminal the window holds: an ordinary terminal tab drawn here instead of in the strip. -->
        <template v-if="window.kind === 'terminal'">
          <TerminalPane
            v-if="terminalHandle(window.id) !== null"
            :handle="terminalHandle(window.id) ?? ''"
            :active="window.focused"
            :interactive="terminalInteractive(window.id)"
            class="h-full"
          />
          <div v-else class="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p class="text-xs text-muted-foreground">{{ t("workbench.tab.ended") }}</p>
            <button
              type="button"
              class="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs transition-colors hover:bg-accent"
              @click="reconnectWindow(window.id)"
            >
              <RotateCw :size="12" />
              {{ t("workbench.tab.retry") }}
            </button>
          </div>
        </template>

        <!-- The file browser, on the workbench's own connection: no tab, no second connection. -->
        <FileBrowser
          v-else-if="window.kind === 'files' && fileHandleOf(window.id) !== null"
          :handle="fileHandleOf(window.id) ?? ''"
          :protocol="session.protocol"
          :initial-path="homeOf(window.id)"
          class="h-full"
        />

        <!-- The monitor's system page, about this host rather than connected to it. -->
        <HostPage v-else-if="window.kind === 'monitor'" :session="session" :active="window.focused" class="h-full">
          <template #default="{ live }">
            <SystemReport :live="live" />
          </template>
        </HostPage>

        <!--
          The machine's Docker, over the connection the desktop already holds. The window body owns
          the engine's whole lifecycle — connecting, failed, the workspace itself — through the
          windowed container tab this window carries.
        -->
        <WorkbenchDockerWindow
          v-else-if="window.kind === 'docker' && dockerTabOf(window.id) !== null"
          :tab="dockerTabOf(window.id) as ContainerTab"
          :active="window.focused"
          class="h-full"
        />

        <!-- Everything this session is moving, in one window. -->
        <WorkbenchTransfersWindow v-else-if="window.kind === 'transfers'" class="h-full" />

        <!--
          The forwards somebody opens while the desktop is up, and the file somebody follows. The
          tail's `active` prop is the long-stream rule: a window nobody is watching stops reading.
        -->
        <WorkbenchForwardsWindow v-else-if="window.kind === 'forwards'" :session-id="session.id" class="h-full" />
        <WorkbenchTailWindow
          v-else-if="window.kind === 'tail'"
          :session-id="session.id"
          :window-id="window.id"
          :active="window.focused"
          class="h-full"
        />

        <!-- Batch execution, against the sessions this machine knows. -->
        <WorkbenchBatchWindow v-else-if="window.kind === 'batch'" class="h-full" />

        <!-- The machine's own details, and the trash: the same panels, in a frame now. -->
        <SystemPanel
          v-else-if="window.kind === 'system' && tab.handle !== null"
          :session-id="session.id"
          :handle="tab.handle"
          :active="window.focused"
          embedded
          class="h-full"
          @close="close(window.id)"
        />
        <TrashWindow
          v-else-if="window.kind === 'trash' && tab.handle !== null"
          :session-id="session.id"
          :handle="tab.handle"
          :active="window.focused"
          embedded
          class="h-full"
          @close="close(window.id)"
        />
      </WorkbenchWindow>
    </div>

    <!--
      The starter, over the whole work area: the reference's application grid. It is a sibling of
      the work area rather than a child of it, so its layer sits above every window's whatever
      number the window stack has reached — a window is drawn at the stacking order it was focused
      in, and a sheet that could be covered by the twenty-first click would be a sheet that stops
      working after a while.
    -->
    <!--
      The wrapper is a layer, not a surface: it carries no pixels of its own and must not catch a
      click when the sheet is closed. Without `pointer-events-none` this transparent rectangle sits
      above the whole desktop and eats every press meant for an icon — the sheet inside is
      `display: none`, but the box around it is still there. The sheet itself turns pointer events
      back on while it is open.
    -->
    <div class="pointer-events-none absolute inset-x-0 top-0 bottom-[57px] z-40" data-workbench-starter-layer>
      <WorkbenchStarter
        :open="starterOpen"
        :apps="starterApps"
        :labels="{
          title: t('workbench.desktop.shell.starter'),
          close: t('common.action.close'),
          search: t('workbench.desktop.shell.starterSearch'),
          noResults: t('workbench.desktop.shell.starterNoResults'),
        }"
        @close="starterOpen = false"
        @launch="launch($event)"
      />
    </div>

    <WorkbenchTaskbar
      :entries="taskbarEntries"
      :clock="clockTime"
      :align="taskbarAlign"
      :power="t('workbench.power.title')"
      :labels="{
        starter: t('workbench.desktop.shell.starter'),
        desktop: t('workbench.desktop.shell.desktop'),
        clock: t('workbench.desktop.clock.title'),
      }"
      @starter="starterOpen = !starterOpen"
      @desktop="pressDesktop()"
      @launch="pressTaskbar($event)"
      @clock="openRecord('system', t('workbench.desktop.icons.system'), 'system')"
      @power="openPowerMenu()"
    />

    <!--
      The shortcut dialog: one field, one path. The rules the input follows live with the shortcuts
      themselves (`lib/workbench/desktopIcons`), and the dialog only refuses to send what they would
      reject — the confirm button is out of reach while the draft is not a path.
    -->
    <DialogRoot :open="creating" @update:open="(value: boolean) => (creating = value)">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-overlay" />
        <DialogContent
          class="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card shadow-xl select-none focus:outline-none"
        >
          <div class="px-4 pt-4">
            <DialogTitle class="text-sm font-medium">{{ t("workbench.desktop.shortcut.title") }}</DialogTitle>
            <DialogDescription class="mt-1 text-xs leading-relaxed text-muted-foreground">
              {{ t("workbench.desktop.shortcut.message") }}
            </DialogDescription>
            <input
              v-model="draftPath"
              type="text"
              spellcheck="false"
              class="mt-3 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs focus:outline-none"
              :aria-label="t('workbench.desktop.shortcut.title')"
              :placeholder="t('workbench.desktop.shortcut.placeholder')"
              @keydown.enter.prevent="createShortcut()"
            />
            <!-- Said only when it is true: a draft nobody has typed yet is not an error. -->
            <p v-if="!draftValid && draftPath.trim() !== ''" class="mt-1.5 text-[11px] text-destructive">
              {{ t("workbench.desktop.shortcut.invalid") }}
            </p>
          </div>
          <footer
            class="mt-4 flex flex-col-reverse gap-2 rounded-b-lg border-t border-border bg-muted/40 px-4 py-3 sm:flex-row sm:justify-end"
          >
            <button
              type="button"
              class="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
              @click="cancelCreateShortcut()"
            >
              {{ t("common.action.cancel") }}
            </button>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              :disabled="!draftValid"
              @click="createShortcut()"
            >
              {{ t("workbench.desktop.shortcut.create") }}
            </button>
          </footer>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <!--
      An icon's properties: what it is called, what kind of thing it is, what it opens, and — for a
      shortcut — the path it stands for, with the two things that are only sensible from here.
    -->
    <DialogRoot
      :open="propertiesIcon !== null"
      @update:open="(value: boolean) => (propertiesIcon = value ? propertiesIcon : null)"
    >
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-overlay" />
        <DialogContent
          class="fixed top-1/2 left-1/2 z-50 w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card shadow-xl select-none focus:outline-none"
          data-workbench-icon-properties
        >
          <div v-if="propertiesIcon" class="px-4 pt-4">
            <DialogTitle class="text-sm font-medium">{{ t("workbench.desktop.properties.title") }}</DialogTitle>
            <DialogDescription class="mt-1 text-xs leading-relaxed text-muted-foreground">
              {{ t(propertiesOpensKey(propertiesIcon)) }}
            </DialogDescription>

            <dl class="mt-3 space-y-1.5 text-xs">
              <div class="flex gap-3">
                <dt class="w-16 shrink-0 text-muted-foreground">{{ t("workbench.desktop.properties.name") }}</dt>
                <dd class="min-w-0 flex-1 truncate" data-properties-name>{{ propertiesIcon.label }}</dd>
              </div>
              <div class="flex gap-3">
                <dt class="w-16 shrink-0 text-muted-foreground">{{ t("workbench.desktop.properties.kind") }}</dt>
                <dd class="min-w-0 flex-1">
                  {{
                    propertiesIcon.kind === "shortcut"
                      ? t("workbench.desktop.properties.kindShortcut")
                      : t("workbench.desktop.properties.kindEntry")
                  }}
                </dd>
              </div>
              <div v-if="propertiesIcon.path" class="flex gap-3">
                <dt class="w-16 shrink-0 text-muted-foreground">{{ t("workbench.desktop.properties.target") }}</dt>
                <dd class="min-w-0 flex-1 break-all font-mono text-[11px]" data-properties-path>
                  {{ propertiesIcon.path }}
                </dd>
              </div>
            </dl>
          </div>
          <footer
            class="mt-4 flex flex-col-reverse gap-2 rounded-b-lg border-t border-border bg-muted/40 px-4 py-3 sm:flex-row sm:justify-end"
          >
            <template v-if="propertiesIcon?.path">
              <button
                type="button"
                class="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                @click="
                  openFilesWindow(propertiesIcon.path, propertiesIcon.label);
                  propertiesIcon = null;
                "
              >
                {{ t("workbench.desktop.properties.openFolder") }}
              </button>
              <button
                type="button"
                class="rounded-md border border-border px-3 py-1.5 text-xs transition-colors hover:bg-accent"
                @click="copyPropertiesPath(propertiesIcon)"
              >
                {{ t("workbench.desktop.properties.copyPath") }}
              </button>
            </template>
            <button
              v-if="propertiesIcon?.kind === 'shortcut'"
              type="button"
              class="rounded-md border border-destructive/40 px-3 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10"
              @click="removeFromProperties(propertiesIcon)"
            >
              {{ t("workbench.desktop.properties.remove") }}
            </button>
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              @click="propertiesIcon = null"
            >
              {{ t("common.action.close") }}
            </button>
          </footer>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <!--
      The desktop's own settings: a backdrop and a density. Two choices, both of them about this
      window rather than about the machine, and neither of them a question anybody is asked twice.
    -->
    <DialogRoot :open="settingsOpen" @update:open="settingsOpen = false">
      <DialogPortal>
        <DialogOverlay class="fixed inset-0 z-50 bg-overlay" />
        <DialogContent
          class="fixed left-1/2 top-1/2 z-50 w-[22rem] -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-card p-4 shadow-lg"
          data-workbench-settings
        >
          <h2 class="text-sm font-medium">{{ t("workbench.desktop.settings.title") }}</h2>

          <h3 class="mb-1 mt-3 text-[11px] font-medium text-muted-foreground">
            {{ t("workbench.desktop.settings.wallpaper") }}
          </h3>
          <div class="flex flex-wrap gap-1.5">
            <button
              type="button"
              class="rounded-md border px-2 py-1 text-[11px] transition-colors"
              :class="
                wallpaper === undefined
                  ? 'border-border bg-accent text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-accent/50'
              "
              @click="chooseWallpaper(null)"
            >
              {{ t("workbench.desktop.settings.wallpaperDefault") }}
            </button>
            <button
              v-for="id in WORKBENCH_WALLPAPER_IDS"
              :key="id"
              type="button"
              class="rounded-md border px-2 py-1 text-[11px] transition-colors"
              :class="
                wallpaper?.kind === 'gradient' && wallpaper.id === id
                  ? 'border-border bg-accent text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-accent/50'
              "
              @click="chooseWallpaper(id)"
            >
              {{ t(`workbench.desktop.settings.wallpapers.${id}`) }}
            </button>
          </div>

          <!--
            A solid colour, with the opacity the washes get: a colour the wallpaper shows at is a
            decision about how much of it to let through, and the slider is that decision.
          -->
          <div class="mt-2 flex items-center gap-2">
            <input
              v-model="draftColor"
              type="color"
              class="size-6 shrink-0 cursor-pointer rounded border border-border"
              data-workbench-setting-color
              :aria-label="t('workbench.desktop.settings.wallpaperColor')"
              @change="applyColor()"
            />
            <input
              v-model.number="draftOpacity"
              type="range"
              min="0.1"
              max="1"
              step="0.05"
              class="h-1 flex-1 cursor-pointer accent-primary"
              data-workbench-setting-opacity
              :aria-label="t('workbench.desktop.settings.wallpaperOpacity')"
              @change="applyColor()"
            />
            <span class="w-9 text-right text-[11px] tabular-nums text-muted-foreground">
              {{ Math.round(draftOpacity * 100) }}%
            </span>
          </div>

          <!--
            A picture of the person's own, scaled to the desk and kept on this device (the session
            carries only the decision). The fill modes are the two a backdrop can have; removing it
            puts the session back on the plain surface.
          -->
          <div class="mt-2 flex flex-wrap items-center gap-2">
            <label
              class="cursor-pointer rounded-md border px-2 py-1 text-[11px] transition-colors hover:bg-accent/50"
              :class="
                backdropIsImage ? 'border-border bg-accent text-foreground' : 'border-border/60 text-muted-foreground'
              "
              data-workbench-setting-image
            >
              {{ t("workbench.desktop.settings.wallpaperImage") }}
              <input
                type="file"
                accept="image/*"
                class="hidden"
                :aria-label="t('workbench.desktop.settings.wallpaperImage')"
                @change="
                  chooseImage(($event.target as HTMLInputElement).files?.[0] as File);
                  ($event.target as HTMLInputElement).value = '';
                "
              />
            </label>
            <template v-if="backdropIsImage">
              <button
                v-for="fill in ['cover', 'contain'] as const"
                :key="fill"
                type="button"
                class="rounded-md border px-2 py-1 text-[11px] transition-colors"
                :class="
                  wallpaper?.kind === 'image' && wallpaper.fill === fill
                    ? 'border-border bg-accent text-foreground'
                    : 'border-border/60 text-muted-foreground hover:bg-accent/50'
                "
                data-workbench-setting-fill
                :data-fill="fill"
                @click="setBackdropFill(fill)"
              >
                {{ t(`workbench.desktop.settings.wallpaperFill.${fill}`) }}
              </button>
              <button
                type="button"
                class="rounded-md border border-destructive/40 px-2 py-1 text-[11px] text-destructive transition-colors hover:bg-destructive/10"
                data-workbench-setting-image-remove
                @click="removeImage()"
              >
                {{ t("workbench.desktop.settings.wallpaperImageRemove") }}
              </button>
            </template>
          </div>

          <h3 class="mb-1 mt-3 text-[11px] font-medium text-muted-foreground">
            {{ t("workbench.desktop.settings.density") }}
          </h3>
          <div class="flex gap-1.5">
            <button
              v-for="density in ['comfortable', 'compact'] as const"
              :key="density"
              type="button"
              class="rounded-md border px-2 py-1 text-[11px] transition-colors"
              :class="
                iconDensity === density
                  ? 'border-border bg-accent text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-accent/50'
              "
              @click="setDensity(density)"
            >
              {{ t(`workbench.desktop.settings.densities.${density}`) }}
            </button>
          </div>

          <!--
            The doors this desktop hides, checked off one by one. A checked box is a door taken off
            the wall — its icon leaves the grid and the starter, and its open path stays intact, so
            unchecking it puts it back exactly where the arrangement says it goes.
          -->
          <h3 class="mb-1 mt-3 text-[11px] font-medium text-muted-foreground">
            {{ t("workbench.desktop.settings.hidden") }}
          </h3>
          <p class="mb-1.5 text-[11px] leading-relaxed text-muted-foreground">
            {{ t("workbench.desktop.settings.hiddenHelp") }}
          </p>
          <div class="grid grid-cols-2 gap-0.5">
            <label
              v-for="(labelKey, id) in HIDEABLE_DOOR_LABEL_KEYS"
              :key="id"
              class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-accent/50"
            >
              <input
                v-model="hiddenDoors"
                type="checkbox"
                class="size-3 shrink-0"
                :value="id"
                data-workbench-setting-door
                :data-door-id="id"
                :aria-label="t(`workbench.desktop.icons.${labelKey}`)"
                @change="persistHiddenDoors()"
              />
              {{ t(`workbench.desktop.icons.${labelKey}`) }}
            </label>
          </div>

          <h3 class="mb-1 mt-3 text-[11px] font-medium text-muted-foreground">
            {{ t("workbench.desktop.settings.taskbarAlign") }}
          </h3>
          <div class="flex gap-1.5">
            <button
              v-for="align in ['left', 'center'] as const"
              :key="align"
              type="button"
              class="rounded-md border px-2 py-1 text-[11px] transition-colors"
              :class="
                taskbarAlign === align
                  ? 'border-border bg-accent text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-accent/50'
              "
              data-workbench-setting-align
              :data-align="align"
              @click="setTaskbarAlign(align)"
            >
              {{ t(`workbench.desktop.settings.${align === "left" ? "taskbarAlignLeft" : "taskbarAlignCenter"}`) }}
            </button>
          </div>

          <!--
            The widgets the desk keeps, checked off one by one: unchecking a widget takes its card
            off the column and stops its share of the sampling with it. The choices are written down
            per session, the way the hidden doors are.
          -->
          <h3 class="mb-1 mt-3 text-[11px] font-medium text-muted-foreground">
            {{ t("workbench.desktop.settings.widgets") }}
          </h3>
          <div class="grid grid-cols-2 gap-0.5">
            <label
              v-for="id in WORKBENCH_WIDGET_IDS"
              :key="id"
              class="flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[11px] transition-colors hover:bg-accent/50"
            >
              <input
                type="checkbox"
                class="size-3 shrink-0"
                :checked="widgetIds.includes(id)"
                data-workbench-setting-widget
                :data-widget-id="id"
                :aria-label="t(`workbench.desktop.widgets.${id}`)"
                @change="setWidget(id, ($event.target as HTMLInputElement).checked)"
              />
              {{ t(`workbench.desktop.widgets.${id}`) }}
            </label>
          </div>

          <footer class="mt-4 flex justify-end">
            <button
              type="button"
              class="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground transition-colors hover:bg-primary/90"
              @click="settingsOpen = false"
            >
              {{ t("common.action.done") }}
            </button>
          </footer>
        </DialogContent>
      </DialogPortal>
    </DialogRoot>

    <ConfirmDialog
      :open="confirming !== null"
      :title="confirmTitle()"
      :message="confirmMessage()"
      :confirm-label="confirmLabel()"
      danger
      @confirm="issuePower()"
      @update:open="confirming = null"
    />
  </section>
</template>
