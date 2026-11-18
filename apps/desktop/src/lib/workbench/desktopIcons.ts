/**
 * The shortcuts a person has put on a session's desktop, as last arranged.
 *
 * The same kind of memory as the recent paths (`./recentPaths`), for a different thing: a recent
 * path is where a browser happened to go, while a shortcut is something somebody chose to keep —
 * but neither is a setting. A desktop's layout is a preference about this machine's screen, not a
 * fact about the session, so it lives in the WebView's own storage and nowhere a settings file or
 * the vault could reach. Losing it costs the shortcuts until they are added again, and nothing else
 * in the application reads it.
 *
 * Keyed by session id, like the recent paths: two sessions reaching one machine may see different
 * file systems through different accounts, and a shortcut that opens nothing would be worse than an
 * empty desktop. The order of the list is the order the icons are drawn in — system icons first,
 * then the shortcuts in the order they were added — and there is no free positioning yet: that is a
 * layout choice the desktop settings will own later.
 */

/** Where the shortcuts live. Versioned, because a map read by a later shape is worth discarding. */
export const WORKBENCH_DESKTOP_SHORTCUTS_KEY = "sevenshell-workbench-desktop-shortcuts-v1";

/** How many shortcuts one session's desktop carries. A desktop, not an archive. */
export const MAX_DESKTOP_SHORTCUTS = 24;

/** One shortcut: what it opens, and the id its menu and its removal are named by. */
export interface DesktopShortcut {
  readonly id: string;
  readonly path: string;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A WebView with storage refused throws on the property itself rather than on a call, and a
    // desktop's icons are not worth failing a render over.
    return null;
  }
}

/**
 * Whether a typed path may become a shortcut.
 *
 * A shortcut is only ever opened as a place the file browser goes to, so the input is refused before
 * it is remembered rather than after it fails to open: an empty path goes nowhere, and a control
 * character would ride into the browser's navigation the way it rides into any path — invisibly.
 */
export function isValidShortcutPath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") {
    return false;
  }
  for (const character of trimmed) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return false;
    }
  }
  return true;
}

/** A shortcut record, or null for anything this build would not have written. */
function shortcut(value: unknown): DesktopShortcut | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const { id, path } = value as Record<string, unknown>;
  if (typeof id !== "string" || id.trim() === "" || typeof path !== "string" || !isValidShortcutPath(path)) {
    return null;
  }
  return { id, path: path.trim() };
}

/** The list's own rules, applied to whatever was read: real shortcuts, no repeats, at most the cap. */
function normalizeShortcuts(values: readonly unknown[]): DesktopShortcut[] {
  const shortcuts: DesktopShortcut[] = [];
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  for (const value of values) {
    const entry = shortcut(value);
    if (entry === null || seenIds.has(entry.id) || seenPaths.has(entry.path)) {
      continue;
    }
    seenIds.add(entry.id);
    seenPaths.add(entry.path);
    shortcuts.push(entry);
    if (shortcuts.length === MAX_DESKTOP_SHORTCUTS) {
      break;
    }
  }
  return shortcuts;
}

/** What was stored, if it still parses into a map of lists. Junk reads as "nothing on the desktop". */
export function parseDesktopShortcuts(raw: string | null): Record<string, DesktopShortcut[]> {
  if (!raw) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {};
  }

  const map: Record<string, DesktopShortcut[]> = {};
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (sessionId.trim() === "" || !Array.isArray(value)) {
      continue;
    }
    const shortcuts = normalizeShortcuts(value);
    if (shortcuts.length > 0) {
      map[sessionId] = shortcuts;
    }
  }
  return map;
}

/**
 * The list after one more shortcut, added at the end — the order the icons are drawn in.
 *
 * A path that is not a path adds nothing and the same list comes back, so a caller can write the
 * answer without comparing contents. A duplicate path adds nothing either: two icons opening the
 * same place is clutter, not two shortcuts. A desktop already at the cap drops its oldest shortcut
 * to make room — the newest ask is the one somebody is looking at, the same rule the recent paths
 * follow from the other end.
 */
export function addShortcut(list: readonly DesktopShortcut[], path: string, id: string): DesktopShortcut[] {
  if (!isValidShortcutPath(path)) {
    return [...list];
  }
  const trimmed = path.trim();
  if (list.some((entry) => entry.path === trimmed)) {
    return [...list];
  }
  const next = [...list, { id, path: trimmed }];
  return next.length > MAX_DESKTOP_SHORTCUTS ? next.slice(next.length - MAX_DESKTOP_SHORTCUTS) : next;
}

/** The list without the shortcut of this id, which is what its menu's Remove asks for. */
export function removeShortcut(list: readonly DesktopShortcut[], id: string): DesktopShortcut[] {
  return list.filter((entry) => entry.id !== id);
}

/** What the icon says under its picture: the path's own last segment, the way a desktop names things. */
export function shortcutName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const last = trimmed.split("/").pop() ?? "";
  return last === "" ? path : last;
}

/** What is remembered on this machine, read when the desktop is drawn. */
export function readDesktopShortcuts(): Record<string, DesktopShortcut[]> {
  return parseDesktopShortcuts(storage()?.getItem(WORKBENCH_DESKTOP_SHORTCUTS_KEY) ?? null);
}

/** Writes the map down. A storage that refuses the write costs the next visit its shortcuts. */
export function writeDesktopShortcuts(map: Readonly<Record<string, DesktopShortcut[]>>): void {
  try {
    storage()?.setItem(WORKBENCH_DESKTOP_SHORTCUTS_KEY, JSON.stringify(map));
  } catch {
    // Full or read-only storage: the shortcuts in this run still stand, and the next launch starts
    // with the system icons.
  }
}
