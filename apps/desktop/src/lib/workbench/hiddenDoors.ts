/**
 * The fixed doors a session has hidden from its desktop, as last chosen in the desktop's settings.
 *
 * Hiding a door is a preference about this machine's screen, not a fact about the session, so it
 * lives where the shortcuts and the arrangement live: the WebView's own storage, keyed by session
 * id. Two sessions reaching one machine may need different doors in reach, and a desktop that hid
 * a door for one of them had hidden it for both if the choice were written anywhere they share.
 *
 * The list is stored as door ids, and the doors it names are dropped from the icon grid and the
 * starter only. The open paths behind them stay intact — hiding is taking the door off the wall,
 * not bricking it up — so clearing the list puts every door back exactly where the arrangement
 * says it goes. Home and the trash are never among the hideable doors: a desktop without a home,
 * or without a trash, is not a desktop.
 */

/** Where one session's hidden doors live. The session id is the rest of the key, as with shortcuts. */
export const WORKBENCH_HIDDEN_DOORS_KEY_PREFIX = "sevenshell-workbench-hidden:";

/**
 * The doors the desktop's settings may hide, as the icon-grid ids that name them.
 *
 * The list is the build's own vocabulary, which is why a stored id that names none of these is
 * dropped on read rather than kept: a door a later build introduced, or a hand-edited key, must
 * not make the desktop hide something it cannot put back.
 */
export const WORKBENCH_HIDEABLE_DOOR_IDS = [
  "system-terminal",
  "system-docker",
  "system-monitor",
  "system-info",
  "system-panel",
  "system-transfers",
  "system-forwards",
  "system-tail",
  "system-batch",
] as const;

/** One door the settings may hide, as its icon-grid id. */
export type WorkbenchHideableDoorId = (typeof WORKBENCH_HIDEABLE_DOOR_IDS)[number];

/** The storage key for one session's desktop. */
export function hiddenDoorsKey(sessionId: string): string {
  return `${WORKBENCH_HIDDEN_DOORS_KEY_PREFIX}${sessionId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A WebView with storage refused throws on the property itself rather than on a call, and a
    // desktop's choices are not worth failing a render over.
    return null;
  }
}

/**
 * What a stored value still says, or null when it says nothing this build can use.
 *
 * Junk is a value a later shape wrote, a hand-edited key, or a half-written string; the default —
 * every door visible — is a perfectly good answer to all three, and a corrupt list that half
 * applied would hide doors nobody asked to hide. Entries that are not non-empty strings, and
 * repeats of an id already kept, are refused for the same reason the shortcut list refuses them.
 */
export function parseHiddenDoors(raw: string | null): string[] | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const hidden: string[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    hidden.push(value);
  }
  return hidden;
}

/**
 * The stored list applied to the doors this build actually can hide.
 *
 * Ids in the list that name no hideable door of this build are dropped — a door was retired, or a
 * build drew one this one does not. What comes back is the set to subtract from the grid, and it
 * can only ever name doors the settings dialog knows how to put back.
 */
export function normalizeHiddenDoors(
  hidden: readonly string[] | null,
  ids: readonly string[] = WORKBENCH_HIDEABLE_DOOR_IDS,
): string[] {
  const hideable = new Set(ids);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of hidden ?? []) {
    if (!hideable.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next;
}

/** What is hidden for this session, or nothing for "this desktop shows every door". */
export function readHiddenDoors(sessionId: string, ids: readonly string[] = WORKBENCH_HIDEABLE_DOOR_IDS): string[] {
  try {
    return normalizeHiddenDoors(parseHiddenDoors(storage()?.getItem(hiddenDoorsKey(sessionId)) ?? null), ids);
  } catch {
    return [];
  }
}

/** Writes the choice down. A storage that refuses the write costs the next visit the choice, not the desktop. */
export function writeHiddenDoors(sessionId: string, hidden: readonly string[]): void {
  try {
    storage()?.setItem(hiddenDoorsKey(sessionId), JSON.stringify(hidden));
  } catch {
    // Full or read-only storage: the choice in this run still stands, and the next visit starts
    // from every door visible.
  }
}

/** Forgets this session's choice, which is how the desktop goes back to showing every door. */
export function clearHiddenDoors(sessionId: string): void {
  try {
    storage()?.removeItem(hiddenDoorsKey(sessionId));
  } catch {
    // A storage that refuses the removal leaves the old choice to be replaced by the next one.
  }
}
