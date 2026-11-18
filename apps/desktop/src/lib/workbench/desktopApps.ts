/**
 * The applications a desktop offers, as metadata.
 *
 * The desktop's doors were, until now, known only to the pane that draws them: the icon grid, the
 * starter and the taskbar each named their applications in their own switch, and adding a door
 * meant finding every one of them. This file is the single source of what the app shelf holds —
 * what it is called, what it opens, what it looks like — so the pane reads a list instead of
 * repeating a switch, and an application added here appears in every surface that draws the shelf.
 *
 * The colours are plate classes rather than tokens: the desktop's icons are app stickers, and the
 * tone is chosen per application the way the fixed doors' tones are. The kind is the window
 * record's own `kind`, which is what the taskbar and the window body look a window up by — the
 * same plain string the geometry library carries, kept as the application's identity rather than
 * a second id beside it.
 */
import { ArrowUpDown, Boxes } from "@lucide/vue";
import type { Component } from "vue";

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
 * which is why the metadata carries no behaviour of its own.
 */
export const DESKTOP_APPS: readonly DesktopApp[] = [
  {
    id: "docker",
    kind: "docker",
    labelKey: "workbench.desktop.icons.docker",
    hintKey: "workbench.desktop.apps.dockerHint",
    icon: Boxes,
    tone: "bg-sky-600/90",
  },
  {
    id: "transfers",
    kind: "transfers",
    labelKey: "workbench.desktop.icons.transfers",
    hintKey: "workbench.desktop.apps.transfersHint",
    icon: ArrowUpDown,
    tone: "bg-cyan-600/90",
  },
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
