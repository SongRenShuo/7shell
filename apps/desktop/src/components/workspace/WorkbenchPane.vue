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
 * This is a desktop, in the ordinary sense of the word: a backdrop the session chose covers the
 * whole tab, a grid of icons sits on it from the top left, a right-click offers what the thing
 * under the pointer can do, and a thin bar along the bottom holds the tabs this session has open.
 * The icons are doors, not pages — double-clicking one opens the thing it names somewhere else in
 * the workspace, and what is left on screen is still this desktop.
 *
 * The connection underneath is an ordinary SSH one, and every door leads somewhere that connection
 * already reaches: the file browser over SFTP, a second terminal, the monitor's pages. The one
 * thing this desktop can ask the machine to *do* is the power action, carried by the taskbar, and
 * it is asked about first: the buttons open the same plain confirmation every destructive action
 * here uses, and the acknowledgement that a person answered it is what travels with the command.
 *
 * The desktop asks for no samples of its own. The readings the first release drew on cards live on
 * the monitor's system page now, and the pages poll by their own rule — a poll nobody can see is
 * somebody else's machine paying for a feature nobody is looking at.
 */
import {
  Cpu,
  ExternalLink,
  Folder,
  Boxes,
  FolderPlus,
  House,
  Info,
  LayoutGrid,
  List,
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
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useI18n } from "vue-i18n";
import { DialogContent, DialogDescription, DialogOverlay, DialogPortal, DialogRoot, DialogTitle } from "reka-ui";

import ConfirmDialog from "@/components/ui/ConfirmDialog.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { useToast } from "@/composables/useToast";
import SystemPanel from "@/components/workspace/SystemPanel.vue";
import TrashWindow from "@/components/workspace/TrashWindow.vue";
import { backend } from "@/lib/backend/api";
import { asShellError } from "@/lib/backend/errors";
import { describeShellError, type Translate } from "@/i18n/errors";
import {
  addShortcut,
  isValidShortcutPath,
  readDesktopShortcuts,
  removeShortcut,
  shortcutName,
  writeDesktopShortcuts,
  type DesktopShortcut,
} from "@/lib/workbench/desktopIcons";
import { clearIconOrder, moveIcon, normalizeIconOrder, readIconOrder, writeIconOrder } from "@/lib/workbench/iconOrder";
import type { MenuEntry } from "@/lib/menu/types";
import type { Session } from "@/types/session";
import { sessionTabTitle } from "@/lib/sessions/reopen";
import {
  useTerminalsStore,
  type FilesTab,
  type InspectTab,
  type InspectView,
  type TerminalTab,
  type WorkbenchTab,
} from "@/stores/terminals";

const props = defineProps<{
  /** The tab this pane draws; its session is what everything here is about. */
  tab: WorkbenchTab;
  /**
   * Whether this pane is the tab on screen. The desktop asks for no samples of its own — the
   * readings live on the monitor's pages, which poll by their own rule — so nothing here reads it
   * today, and the frame keeps handing it over so a later reader does not re-plumb the workspace.
   */
  active: boolean;
}>();

const { t, locale } = useI18n();
const terminals = useTerminalsStore();
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
const wallpaper = computed(() => {
  const wanted = chosenWallpaper.value ?? session.value.workbench?.wallpaper;
  if (wanted === undefined || !WORKBENCH_WALLPAPER_IDS.includes(wanted as WorkbenchWallpaperId)) {
    return undefined;
  }
  return wanted;
});

/**
 * The backdrop chosen in this window, before the vault has been written back.
 *
 * Saving a session answers with the stored one, but the tab's own copy is what the desktop draws
 * from; keeping the choice here means the wallpaper changes the moment somebody picks it, and a
 * save that fails leaves the old one on screen rather than a lie.
 */
const chosenWallpaper = ref<string | null>(null);

const WALLPAPER_BACKDROPS: Readonly<Record<string, string>> = {
  aurora: "linear-gradient(165deg, #1e1b4b 0%, #312e81 45%, #155e75 100%)",
  dawn: "linear-gradient(165deg, #431407 0%, #9a3412 55%, #b45309 100%)",
  forest: "linear-gradient(165deg, #052e16 0%, #14532d 55%, #3f6212 100%)",
  plain: "",
};

const wallpaperStyle = computed(() => {
  const id = wallpaper.value;
  if (id === undefined) {
    return undefined;
  }
  return { background: WALLPAPER_BACKDROPS[id] };
});

/**
 * Whether the desktop is drawn on a picture rather than on the interface's own surface.
 *
 * It decides one thing, and it decides it for every icon: on a wallpaper the chrome stops
 * following the theme. A wallpaper is a picture — the four this build ships are all dark washes —
 * and a light theme's near-black labels on one of them are the "nothing is legible" state the
 * first release actually shipped. White with a soft shadow reads on all four and needs no
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
  readonly kind: "home" | "terminal" | "monitor" | "systemInfo" | "system" | "trash" | "shortcut";
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
 * The doors every desktop has, in the order the grid draws them.
 *
 * The monitor door and the system-information door lead to the same page on purpose: the readings
 * the first release drew on cards live on the monitor's system page, and both names are ways of
 * asking for it — `openInspect` answers a second ask with the tab that is already there rather than
 * a second copy of it.
 */
const systemIcons = computed<DesktopIcon[]>(() => [
  { id: "system-home", kind: "home", label: t("workbench.desktop.icons.home"), icon: House },
  { id: "system-terminal", kind: "terminal", label: t("workbench.desktop.icons.terminal"), icon: Terminal },
  { id: "system-monitor", kind: "monitor", label: t("workbench.desktop.icons.monitor"), icon: ListTree },
  { id: "system-info", kind: "systemInfo", label: t("workbench.desktop.icons.systemInfo"), icon: Info },
  {
    id: "system-panel",
    kind: "system",
    label: t("workbench.desktop.icons.system"),
    icon: Boxes,
  },
  {
    id: "system-trash",
    kind: "trash",
    label: t("workbench.desktop.icons.trash"),
    icon: Trash2,
  },
]);

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

/**
 * Every icon this desktop has, in the order it would draw them before anybody arranges them: the
 * fixed doors first, then the shortcuts in the order they were added.
 */
const defaultIcons = computed<DesktopIcon[]>(() => [...systemIcons.value, ...userIcons.value]);

/**
 * The arrangement this session's desktop was left in, or null while nobody has moved anything.
 *
 * Read once, when the pane is drawn: an arrangement is written by this pane and by nothing else, so
 * there is no second writer to keep up with. The ids are the icons' own — `system-…` for the fixed
 * doors, `shortcut:<shortcutId>` for a shortcut — because an id keeps meaning the same icon when
 * the list around it grows, while a position would not.
 */
const iconOrder = ref<string[] | null>(readIconOrder(session.value.id));

/** The icons in the order the grid draws them: the recorded arrangement with the defaults filled in. */
const icons = computed<DesktopIcon[]>(() => {
  const byId = new Map(defaultIcons.value.map((icon) => [icon.id, icon]));
  const ordered: DesktopIcon[] = [];
  for (const id of normalizeIconOrder(
    iconOrder.value,
    defaultIcons.value.map((icon) => icon.id),
  )) {
    const icon = byId.get(id);
    if (icon !== undefined) {
      ordered.push(icon);
    }
  }
  return ordered;
});

/** Which icon is being dragged, and which one the pointer is over — the second is for the highlight. */
const draggingId = ref<string | null>(null);
const dragOverId = ref<string | null>(null);

/**
 * Picks an icon up without touching the selection.
 *
 * A drag is not a click, and the browser suppresses the click that would normally follow one; this
 * handler deliberately does not select what it picks up either. Somebody arranging the desktop is
 * not asking to open anything, and a desktop that opened what a drag passed over would be one
 * nobody dares tidy.
 */
function beginDrag(event: DragEvent, icon: DesktopIcon): void {
  draggingId.value = icon.id;
  dragOverId.value = null;
  // A drag that carries nothing is not started at all in some engines, so the id rides along.
  event.dataTransfer?.setData("text/plain", icon.id);
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = "move";
  }
}

function dragOver(icon: DesktopIcon): void {
  dragOverId.value = draggingId.value !== null && draggingId.value !== icon.id ? icon.id : null;
}

/** The wallpaper between the icons: a drop here means the end of the grid, so no icon is lit. */
function dragOverDesktop(): void {
  dragOverId.value = null;
}

function endDrag(): void {
  draggingId.value = null;
  dragOverId.value = null;
}

/**
 * Puts the dragged icon where the drop landed, and writes the result down.
 *
 * Dropping onto nothing — the wallpaper between the icons — is the end of the grid, the way it is
 * on any desktop. A drop that changes nothing writes nothing, so a mis-aimed drag does not leave an
 * arrangement behind that is the default order spelled out.
 */
function dropIcon(target: DesktopIcon | null): void {
  const from = draggingId.value;
  endDrag();
  if (from === null) {
    return;
  }
  const current = icons.value.map((icon) => icon.id);
  const next = moveIcon(current, from, target?.id ?? null);
  if (next.every((id, index) => id === current[index])) {
    return;
  }
  iconOrder.value = next;
  writeIconOrder(session.value.id, next);
}

/** Puts the grid back in its default order for this session, forgetting the arrangement. */
function resetIconOrder(): void {
  iconOrder.value = null;
  clearIconOrder(session.value.id);
}

/** The icon somebody has clicked, which the Enter key opens and a click on the wallpaper clears. */
const selectedId = ref<string | null>(null);

/**
 * Whether the trash panel is open over the desktop.
 *
 * A panel rather than a tab: the trash is a place inside this machine's desktop — the same machine
 * the desktop is about — and opening it in a tab of its own would be a second window onto one
 * session. The panel closes with its own cross and goes with the tab.
 */
const trashOpen = ref(false);

/**
 * Whether the system panel is open over the desktop. Like the trash, it is a place inside this
 * machine's desktop rather than a tab of its own — and the two share the floor: a desktop with
 * two panels stacked would be a window manager, which this is not.
 */
const systemOpen = ref(false);

/** Whether the desktop's own settings are open: the two choices a desktop has here. */
const settingsOpen = ref(false);

/**
 * How wide the icon cells are, which is the desktop's density.
 *
 * A device preference rather than a session one: the same machine looks right at the same density
 * on both of somebody's computers, and this is a window that may be small. It lives in the same
 * storage as the shortcuts — the WebView's own — and defaults to comfortable.
 */
const ICON_DENSITY_KEY = "sevenshell-workbench-density";
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
    // A window that cannot remember the choice still honours it for this run.
  }
}

/** Picks a backdrop (or none) and writes the session back, leaving the old one on a failure. */
async function chooseWallpaper(id: string | null): Promise<void> {
  const next: Session = {
    ...session.value,
    workbench: { ...session.value.workbench, wallpaper: id ?? undefined },
  };
  try {
    await backend.sessions.save(next);
    chosenWallpaper.value = id;
    toast(t("workbench.desktop.settings.saved"), "receipt");
  } catch (error) {
    toast(describeShellError(translate as Translate, asShellError(error, "session_save")).message, "failure");
  }
}

function select(icon: DesktopIcon): void {
  selectedId.value = icon.id;
}

function clearSelection(): void {
  selectedId.value = null;
}

/**
 * Opens what an icon names, somewhere else in the workspace.
 *
 * A path handed to the file browser is a place to be: a browser that is already up walks there
 * through the navigation it already uses, and one that is not opens on it — the store owns both
 * shapes, and the icon does not care which it gets.
 */
function openIcon(icon: DesktopIcon): void {
  if (icon.disabled) {
    return;
  }
  selectedId.value = icon.id;
  switch (icon.kind) {
    case "home":
      void terminals.openFiles(session.value);
      return;
    case "terminal":
      // Not `open`: the fork that mounts the workbench is what a session's open *is* here, and the
      // store's terminal-only path exists for exactly this ask.
      void terminals.openTerminalTab(session.value);
      return;
    // Two names, one destination: see `systemIcons`.
    case "monitor":
    case "systemInfo":
      terminals.openInspect("system", session.value);
      return;
    case "system":
      // Opening, not toggling: a desktop icon is a door, and a door that closed when somebody
      // opened it twice in one gesture is a door that looks broken. The panel's own cross closes it.
      openSystemPanel();
      return;
    case "trash":
      trashOpen.value = true;
      systemOpen.value = false;
      return;
    case "shortcut":
      void terminals.openFiles(session.value, icon.path);
      return;
  }
}

/**
 * Opens the system panel over the desktop, closing the trash.
 *
 * The two panels share one floor — a desktop with two of them stacked would be a window manager,
 * which this is not — so every door to one closes the other. The clock is the second door to this
 * one: a clock on a desktop opens the machine's own panel, which is exactly what this panel is.
 */
function openSystemPanel(): void {
  systemOpen.value = true;
  trashOpen.value = false;
}

// -- the menus ---------------------------------------------------------------

function persistShortcuts(): void {
  writeDesktopShortcuts({ ...readDesktopShortcuts(), [session.value.id]: shortcuts.value });
}

/**
 * What the wallpaper offers when it is right-clicked.
 *
 * Refresh re-reads what storage holds — the icons are memory, not a live view of the machine, so
 * that is the whole of what refreshing can mean. Reset layout forgets the arrangement this session
 * was left in, which is how somebody gets the default order back without clearing storage by hand.
 * The settings entry opens the desktop's own two choices: a backdrop and a density.
 */
function openDesktopMenu(event: MouseEvent): void {
  openMenu(event, { key: "workbench.desktop.title" }, [
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
    { kind: "separator", id: "desktop-sep" },
    {
      kind: "action",
      id: "desktop-settings",
      labelKey: "workbench.desktop.menu.settings",
      icon: Settings,
      run: () => {
        settingsOpen.value = true;
      },
    },
  ]);
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
    disabled: true,
    run: () => {},
  });
  openMenu(event, { key: "workbench.desktop.title" }, entries);
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

// -- the taskbar -------------------------------------------------------------

/** One entry of the taskbar: a tab this session has open, named the way the strip names it. */
interface TaskbarEntry {
  readonly id: string;
  readonly label: string;
  readonly icon: Component;
}

function inspectTitleKey(view: InspectView): string {
  switch (view) {
    case "system":
      return "inspect.system.title";
    case "processes":
      return "inspect.processes.title";
    default:
      return "inspect.network.title";
  }
}

function taskbarLabel(tab: TerminalTab | FilesTab | InspectTab): string {
  if (tab.kind === "inspect") {
    // A page names the machine it is about, the way the strip names it.
    return `${t(inspectTitleKey(tab.view))} · ${tab.session.host}`;
  }
  // A session opened twice is drawn twice, and the copy number tells them apart.
  return sessionTabTitle(tab.session.name, terminals.copyOf(tab.id));
}

function taskbarIcon(tab: TerminalTab | FilesTab | InspectTab): Component {
  switch (tab.kind) {
    case "terminal":
      return Terminal;
    case "files":
      return Folder;
    case "inspect":
      return tab.view === "system" ? Cpu : tab.view === "processes" ? List : Network;
    default:
      return Terminal;
  }
}

/**
 * The tabs of this session only: a shell, a browser, or a page about this host. The workbench tab
 * itself is the desktop these sit behind, so it is not an entry of its own.
 */
const taskbarEntries = computed<TaskbarEntry[]>(() =>
  terminals.tabs
    .filter(
      (tab): tab is TerminalTab | FilesTab | InspectTab =>
        (tab.kind === "terminal" || tab.kind === "files" || tab.kind === "inspect") &&
        tab.session.id === session.value.id,
    )
    .map((tab) => ({ id: tab.id, label: taskbarLabel(tab), icon: taskbarIcon(tab) })),
);

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
  clockTicker = setInterval(() => {
    now.value = new Date();
  }, 60_000);
});

onUnmounted(() => {
  if (clockTicker !== undefined) {
    clearInterval(clockTicker);
    clockTicker = undefined;
  }
});

/** The hour and minute, in the interface's language: 24-hour, because that is what a log reads. */
const clockTime = computed(() =>
  new Intl.DateTimeFormat(locale.value, { hour: "2-digit", minute: "2-digit", hour12: false }).format(now.value),
);

/** The date, shown only when the bar has room for it — the month and day a desktop clock adds. */
const clockDate = computed(() =>
  new Intl.DateTimeFormat(locale.value, { month: "short", day: "numeric" }).format(now.value),
);

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
</script>

<template>
  <!--
    The backdrop is the desktop's own, and it covers the whole tab — icons, taskbar and all, the way
    a wallpaper on any desktop stops nowhere in particular. Without one the interface's own surface
    is the backdrop, which is the elevation the tokens already speak.
  -->
  <section
    class="flex min-h-0 flex-1 flex-col overflow-hidden"
    :class="wallpaper === undefined ? 'bg-background' : undefined"
    :style="wallpaperStyle"
  >
    <!--
      The desktop: the icons from the top left, and nothing else on it. A click on the wallpaper
      clears the selection, because on a desktop that is what clicking nowhere means; an icon stops
      the click on its way up, because selecting it is not clicking nowhere. A drop on the wallpaper
      is where a dragged icon goes when it is not dropped onto another one: the end of the grid.
    -->
    <div
      data-workbench-desktop
      class="min-h-0 flex-1 overflow-y-auto"
      @click="clearSelection()"
      @contextmenu="openDesktopMenu"
      @dragover.prevent="dragOverDesktop()"
      @drop.prevent="dropIcon(null)"
    >
      <div
        class="grid max-w-full content-start justify-start gap-1 p-3"
        :class="
          iconDensity === 'compact' ? 'grid-cols-[repeat(auto-fill,4.5rem)]' : 'grid-cols-[repeat(auto-fill,6rem)]'
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
          class="flex flex-col items-center gap-1.5 rounded-lg border px-2 py-2.5 text-xs transition-colors"
          :class="[
            onPicture
              ? selectedId === icon.id
                ? 'border-white/35 bg-white/15 text-white'
                : 'border-transparent text-white/95 hover:bg-white/10'
              : selectedId === icon.id
                ? 'border-border/60 bg-accent text-foreground'
                : 'border-transparent text-foreground hover:bg-accent/50',
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
          <component
            :is="icon.icon"
            :size="28"
            class="shrink-0"
            :class="onPicture ? 'drop-shadow-[0_1px_3px_rgba(0,0,0,0.55)]' : undefined"
            :stroke-width="1.5"
          />
          <span
            class="w-full truncate text-center leading-tight"
            :class="onPicture ? '[text-shadow:0_1px_2px_rgba(0,0,0,0.6)]' : undefined"
            >{{ icon.label }}</span
          >
        </button>
      </div>
    </div>

    <!--
      The trash, when its icon has opened it: a panel over the desktop rather than a tab, because
      it is a place inside this machine's desktop and a tab would be a second window onto one
      session. A session with no connection has nothing to read, so the icon does nothing there.
    -->
    <SystemPanel
      v-if="systemOpen && tab.handle !== null"
      :session-id="session.id"
      :handle="tab.handle"
      :active="active"
      class="h-[58%] shrink-0 border-t border-border bg-card"
      @close="systemOpen = false"
    />

    <TrashWindow
      v-if="trashOpen && tab.handle !== null"
      :session-id="session.id"
      :handle="tab.handle"
      :active="active"
      class="h-[58%] shrink-0 border-t border-border bg-card"
      @close="trashOpen = false"
    />
    <footer
      data-workbench-taskbar
      class="flex shrink-0 items-center gap-1 border-t border-border bg-card px-2 py-1 select-none"
    >
      <button
        v-for="entry in taskbarEntries"
        :key="entry.id"
        type="button"
        data-workbench-taskbar-entry
        :data-tab-id="entry.id"
        class="flex max-w-40 shrink items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors"
        :class="
          entry.id === terminals.activeTabId
            ? 'bg-accent text-foreground'
            : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
        "
        :title="entry.label"
        @click="terminals.activateTab(entry.id)"
      >
        <component :is="entry.icon" :size="12" class="shrink-0" />
        <span class="truncate">{{ entry.label }}</span>
      </button>

      <span class="min-w-0 flex-1"></span>

      <div class="flex shrink-0 items-center gap-1 border-l border-border pl-2" data-workbench-power>
        <button
          type="button"
          :disabled="!connected"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
          @click="confirming = 'reboot'"
        >
          <RotateCw :size="12" />
          {{ t("workbench.power.reboot") }}
        </button>
        <button
          type="button"
          :disabled="!connected"
          class="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
          @click="confirming = 'shutdown'"
        >
          <Power :size="12" />
          {{ t("workbench.power.shutdown") }}
        </button>
      </div>

      <!--
        The clock, at the far end of the bar. Clicking it opens the system panel — the same door the
        system-information icon opens — because on a desktop a clock is usually the quickest way to
        what the machine is doing. The date rides beside it only when the bar is wide enough.
      -->
      <button
        type="button"
        data-workbench-clock
        :title="t('workbench.desktop.clock.title')"
        :aria-label="t('workbench.desktop.clock.title')"
        class="flex shrink-0 items-baseline gap-1.5 rounded-md border-l border-border py-1 pr-1 pl-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        @click="openSystemPanel()"
      >
        <span data-workbench-clock-time class="tabular-nums">{{ clockTime }}</span>
        <span data-workbench-clock-date class="hidden sm:inline">{{ clockDate }}</span>
      </button>
    </footer>

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
                wallpaper === id
                  ? 'border-border bg-accent text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-accent/50'
              "
              @click="chooseWallpaper(id)"
            >
              {{ t(`workbench.desktop.settings.wallpapers.${id}`) }}
            </button>
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
