/**
 * The desktop's doors and applications, as metadata.
 *
 * Every surface that names a door — the icon grid, the starter sheet, the taskbar, the windows'
 * title bars — used to keep its own switch: adding a door meant finding all of them, and two of
 * them disagreed about the Docker glyph. This file is the single source of what a door is called,
 * what it looks like and what tone its plate carries, so the pane reads lists from here and an
 * application added here appears in every surface that draws the shelf.
 *
 * The colours are plate classes rather than tokens: the desktop's icons are app stickers, and the
 * tone is chosen per application the way a launcher chooses one. The kind is the window record's
 * own `kind`, which is what the taskbar and the window body look a window up by — the same plain
 * string the geometry library carries, kept as the application's identity rather than a second id
 * beside it.
 */
import {
  ArrowUpDown,
  Boxes,
  Cpu,
  FileText,
  Folder,
  Globe,
  House,
  Info,
  ListChecks,
  ListTree,
  Network,
  Terminal,
  Trash2,
} from "@lucide/vue";
import type { Component } from "vue";

/**
 * One door the desktop draws: an entry on the icon grid and a tile on the starter sheet.
 *
 * The `id` is the icon-grid id — with the `system-` prefix that keeps a shortcut's own id from
 * colliding with it, and the id the hidden-doors storage names the door by. The `kind` is the
 * window kind the door opens and the starter tile's own id, both the same string.
 */
export interface WorkbenchDoor {
  readonly id: string;
  readonly kind: string;
  readonly labelKey: string;
  /** The glyph on the door's plate, in the grid and on the starter. */
  readonly icon: Component;
  /**
   * The plate behind the glyph: the same tone in the grid, the starter and the taskbar. The
   * `/90` opacity is the contract — a door drawn at any other opacity is not the door the other
   * surfaces drew.
   */
  readonly tone: string;
}

/**
 * The doors every desktop has, in the order the grid draws them.
 *
 * The monitor door and the system-information door lead to the same page on purpose: the readings
 * the first release drew on cards live on the monitor's system page, and both names are ways of
 * asking for it. Home and the trash are never hidden from this list's consumers: a desktop without
 * a home, or without a trash, is not a desktop — the pane's hiding logic is what leaves them on.
 */
export const WORKBENCH_DOORS: readonly WorkbenchDoor[] = [
  { id: "system-home", kind: "home", labelKey: "workbench.desktop.icons.home", icon: House, tone: "bg-amber-500/90" },
  {
    id: "system-terminal",
    kind: "terminal",
    labelKey: "workbench.desktop.icons.terminal",
    icon: Terminal,
    tone: "bg-emerald-500/90",
  },
  {
    id: "system-docker",
    kind: "docker",
    labelKey: "workbench.desktop.icons.docker",
    icon: Boxes,
    tone: "bg-sky-600/90",
  },
  {
    id: "system-monitor",
    kind: "monitor",
    labelKey: "workbench.desktop.icons.monitor",
    icon: ListTree,
    tone: "bg-sky-500/90",
  },
  {
    id: "system-info",
    kind: "systemInfo",
    labelKey: "workbench.desktop.icons.systemInfo",
    icon: Info,
    tone: "bg-sky-500/90",
  },
  {
    id: "system-panel",
    kind: "system",
    labelKey: "workbench.desktop.icons.system",
    icon: Boxes,
    tone: "bg-violet-500/90",
  },
  {
    id: "system-transfers",
    kind: "transfers",
    labelKey: "workbench.desktop.icons.transfers",
    icon: ArrowUpDown,
    tone: "bg-cyan-600/90",
  },
  {
    id: "system-forwards",
    kind: "forwards",
    labelKey: "workbench.desktop.icons.forwards",
    icon: Network,
    tone: "bg-indigo-600/90",
  },
  { id: "system-tail", kind: "tail", labelKey: "workbench.desktop.icons.tail", icon: FileText, tone: "bg-teal-600/90" },
  {
    id: "system-batch",
    kind: "batch",
    labelKey: "workbench.desktop.icons.batch",
    icon: ListChecks,
    tone: "bg-orange-600/90",
  },
  {
    id: "system-trash",
    kind: "trash",
    labelKey: "workbench.desktop.icons.trash",
    icon: Trash2,
    tone: "bg-rose-500/90",
  },
];

/** The applications this build puts on the desktop, by id. */
export type DesktopAppId = "docker" | "transfers";

/** One application on the desktop's shelf: what it says, what it opens as, and what it looks like. */
export interface DesktopApp {
  readonly id: DesktopAppId;
  /**
   * The kind of window this application opens, and the key the desktop's surfaces look it up by —
   * the icon grid's kind, the starter's id, the window record's `kind` and the taskbar cell's are
   * all this one string.
   */
  readonly kind: DesktopAppId;
  /** The name, drawn under the icon, on the starter tile and as the window's title. */
  readonly labelKey: string;
  /** The one sentence about what opens, for whichever surface has room to say it. */
  readonly hintKey: string;
  readonly icon: Component;
  /** The plate behind the glyph: the same tone in the grid, the starter and the taskbar. */
  readonly tone: string;
}

/**
 * The applications the desktop offers, in the order the shelf draws them.
 *
 * The Docker door opens the container workspace in a window on the session's own connection; the
 * transfer door opens the list of what is moving. Both are existing surfaces met through a window,
 * and both are doors first: their glyphs and tones are read out of {@link WORKBENCH_DOORS} rather
 * than restated, so the shelf cannot drift from the grid it is a view of.
 */
function shelfApp(kind: DesktopAppId, hintKey: string): DesktopApp {
  const door = WORKBENCH_DOORS.find((entry) => entry.kind === kind);
  if (door === undefined) {
    throw new Error(`the app shelf names ${kind}, which the door table does not carry`);
  }
  return { id: kind, kind, labelKey: door.labelKey, hintKey, icon: door.icon, tone: door.tone };
}

export const DESKTOP_APPS: readonly DesktopApp[] = [
  shelfApp("docker", "workbench.desktop.apps.dockerHint"),
  shelfApp("transfers", "workbench.desktop.apps.transfersHint"),
];

/**
 * The application a window kind names, or nothing for a kind this shelf does not carry.
 *
 * The desktop's windows are more than its applications — a terminal, a file browser and the
 * machine's panels all open as windows too — and those keep their own names in the pane. This
 * answers only about the app shelf.
 */
export function desktopApp(kind: string): DesktopApp | null {
  return DESKTOP_APPS.find((app) => app.kind === kind) ?? null;
}

/** Whether a window kind is one of the desktop's applications. */
export function opensWindow(kind: string): boolean {
  return desktopApp(kind) !== null;
}

/**
 * The tone of a window kind's plate, wherever a door is drawn.
 *
 * The door table answers for the doors; a file window and a shortcut share the home door's amber —
 * they are the same browser at different addresses — and a kind this table has never heard of
 * draws the neutral slate, which is a plate rather than an error.
 */
export function workbenchToneOf(kind: string): string {
  const door = WORKBENCH_DOORS.find((entry) => entry.kind === kind);
  if (door !== undefined) {
    return door.tone;
  }
  switch (kind) {
    case "files":
    case "shortcut":
      return "bg-amber-500/90";
    default:
      return "bg-slate-500/90";
  }
}

/**
 * The glyph beside a window's title and on its taskbar cell.
 *
 * A window is looked up by kind rather than by door id, because windows exist that no door opens:
 * the file browser is one. The monitor's window carries the reading glyph rather than the grid's —
 * the two names the grid gives that page both open the same window, and the window says what it is
 * once, not once per door.
 */
export function workbenchIconOf(kind: string): Component {
  switch (kind) {
    case "terminal":
      return Terminal;
    case "files":
      return Folder;
    case "monitor":
    case "systemInfo":
      return Cpu;
    case "system":
      return Boxes;
    default: {
      const door = WORKBENCH_DOORS.find((entry) => entry.kind === kind);
      return door?.icon ?? Globe;
    }
  }
}
