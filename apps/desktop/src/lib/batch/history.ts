/**
 * The commands the batch panel has run, kept for recall.
 *
 * A command that reached ten machines is worth reaching again: the panel keeps the ones it has
 * run, newest first, and the textarea walks them with the arrow keys the way a shell does — up
 * for the one before, down for the one after, stopping at the present.
 *
 * The list is this device's, not a connection's (a command is about the person typing it, not the
 * machine it lands on), and it survives the application closing, because that is when it is most
 * wanted. A full or refusing store costs the memory, never the panel.
 */

/** How many commands the history keeps: enough to cover a working day, few enough to scan. */
export const BATCH_HISTORY_LIMIT = 30;

const HISTORY_KEY = "batch:history";

/** The commands previously run, most recent first, already deduplicated. */
export function loadHistory(): string[] {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(HISTORY_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  } catch {
    return [];
  }
}

/**
 * Records a command that was just run: to the front, a repeat of the newest entry collapsed, the
 * tail falling off past the limit. Returns the list as it now stands.
 */
export function pushHistory(command: string): string[] {
  const trimmed = command.trim();
  if (trimmed === "") {
    return loadHistory();
  }
  const next = [trimmed, ...loadHistory().filter((item) => item !== trimmed)].slice(0, BATCH_HISTORY_LIMIT);
  if (typeof window !== "undefined" && "localStorage" in window) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
    } catch {
      // The memory is a courtesy: the run itself does not depend on it.
    }
  }
  return next;
}

/** Forgets the whole list: the menu's clear control. */
export function clearHistory(): void {
  if (typeof window !== "undefined" && "localStorage" in window) {
    try {
      window.localStorage.removeItem(HISTORY_KEY);
    } catch {
      // Nothing the run depends on.
    }
  }
}
