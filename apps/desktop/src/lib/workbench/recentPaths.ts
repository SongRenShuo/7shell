/**
 * The directories a session's file browsing has been in, as last seen.
 *
 * Usage memory rather than a setting, kept the way the recent-session list is kept
 * (`lib/sessions/recent`) and the way the system marks are kept (`lib/system/cache`): a session
 * document says what somebody saved, while this says where a browser happened to go — nothing a
 * person chose, nothing with a default, and nothing a settings page could explain or restore. It
 * lives in the WebView's own storage for the same reason: losing it costs a few shortcuts until
 * the next visit, and nothing else in the application reads it.
 *
 * Keyed by session id, because the entries are shortcuts into *that* session's browsing: two
 * sessions reaching one machine may still see different file systems through different accounts,
 * and an entry that opened nothing would be worse than an empty list.
 */

/** Where the paths live. Versioned, because a map read by a later shape is worth discarding. */
export const WORKBENCH_RECENT_PATHS_KEY = "sevenshell-workbench-recent-paths-v1";

/** How many directories are remembered per session. A shortcut list, not a history. */
export const MAX_REMEMBERED_PATHS = 5;

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A WebView with storage refused throws on the property itself rather than on a call, and a
    // shortcut list is not worth failing a render over.
    return null;
  }
}

/** A string field, or null for anything else: this reads storage, which is not necessarily ours. */
function path(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/** The list's own rules, applied to whatever was read: strings, no repeats, at most the cap. */
function normalizePaths(values: readonly unknown[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const entry = path(value);
    if (entry === null || seen.has(entry)) {
      continue;
    }
    seen.add(entry);
    paths.push(entry);
    if (paths.length === MAX_REMEMBERED_PATHS) {
      break;
    }
  }
  return paths;
}

/** What was stored, if it still parses into a map of lists. Junk reads as "nothing remembered". */
export function parseRecentPaths(raw: string | null): Record<string, string[]> {
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

  const map: Record<string, string[]> = {};
  for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (sessionId.trim() === "" || !Array.isArray(value)) {
      continue;
    }
    const paths = normalizePaths(value);
    if (paths.length > 0) {
      map[sessionId] = paths;
    }
  }
  return map;
}

/**
 * The list after one more visit: the directory moves to the front and the oldest falls off.
 *
 * An empty path is not a visit anywhere, so the same list comes back — a caller can write it
 * without comparing contents, the way `rememberSystem` answers a host that kept quiet.
 */
export function rememberPath(history: readonly string[], path: string): string[] {
  if (path.trim() === "") {
    return [...history];
  }
  return normalizePaths([path, ...history]);
}

/** What is remembered on this machine, read when the pane is drawn. */
export function readRecentPaths(): Record<string, string[]> {
  return parseRecentPaths(storage()?.getItem(WORKBENCH_RECENT_PATHS_KEY) ?? null);
}

/** Writes the map down. A storage that refuses the write costs the next visit its shortcuts. */
export function writeRecentPaths(map: Readonly<Record<string, string[]>>): void {
  try {
    storage()?.setItem(WORKBENCH_RECENT_PATHS_KEY, JSON.stringify(map));
  } catch {
    // Full or read-only storage: the shortcuts in this run still stand, and the next launch starts
    // empty.
  }
}
