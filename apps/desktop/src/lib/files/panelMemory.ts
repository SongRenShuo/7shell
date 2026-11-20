/**
 * What the file panel remembers about how it was used, kept per session.
 *
 * Three things ride here: the directories this session has walked into (the recent list the
 * recent menu offers), the order the listing was last drawn in, and nothing else — a filter asked
 * for in one directory stays a view of that panel, and a favorite is a bookmark, which is a fact
 * about the person rather than the session.
 *
 * Every key carries the session id (LESSONS I15): the same panel on two connections must not hand
 * one server's history to another. The lists survive the tab closing and the window hiding, and
 * a store that answers nothing (a private window, a wiped store) reads as empty rather than
 * throwing.
 */
import { type ListingSort } from "@/lib/files/order";

/** The most recent directories the menu offers: enough to matter, few enough to scan. */
export const RECENT_LIMIT = 8;

const RECENT_KEY = (session: string): string => `files:recent:${session}`;
const ORDER_KEY = (session: string): string => `files:order:${session}`;

function readList(key: string): string[] {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function writeList(key: string, paths: readonly string[]): void {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return;
  }
  try {
    window.localStorage.setItem(key, JSON.stringify(paths));
  } catch {
    // A full or refusing store costs the memory, not the panel: the list simply stops being kept.
  }
}

/** The directories this session has recently walked into, most recent first. */
export function loadRecent(session: string): string[] {
  return readList(RECENT_KEY(session));
}

/**
 * Records a directory the session just walked into: to the front, the duplicates collapsed (a
 * directory visited twice in a row is one entry), the tail falling off past the limit. Returns the
 * list as it now stands, so the caller can draw it without a second read.
 */
export function pushRecent(session: string, path: string): string[] {
  const next = [path, ...loadRecent(session).filter((item) => item !== path)].slice(0, RECENT_LIMIT);
  writeList(RECENT_KEY(session), next);
  return next;
}

/** Forgets the whole list: the menu's clear control, not a per-entry removal. */
export function clearRecent(session: string): void {
  writeList(RECENT_KEY(session), []);
}

/** The order the listing was last drawn in, or null when this session has none worth restoring. */
export function loadOrder(session: string): { column: ListingSort; descending: boolean } | null {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return null;
  }
  try {
    const raw = window.localStorage.getItem(ORDER_KEY(session));
    if (raw === null) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const { column, descending } = parsed as { column?: unknown; descending?: unknown };
    const columns: ListingSort[] = ["name", "size", "kind", "modified", "mode", "owner"];
    if (typeof column !== "string" || !columns.includes(column as ListingSort)) {
      return null;
    }
    return { column: column as ListingSort, descending: descending === true };
  } catch {
    return null;
  }
}

/** Remembers the order: written the moment a heading is pressed, read when the session mounts. */
export function saveOrder(session: string, order: { column: ListingSort; descending: boolean }): void {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return;
  }
  try {
    window.localStorage.setItem(ORDER_KEY(session), JSON.stringify(order));
  } catch {
    // As with the lists: a refusing store costs the memory, not the panel.
  }
}
