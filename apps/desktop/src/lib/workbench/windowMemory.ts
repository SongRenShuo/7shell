/**
 * Where each kind of window was last left, remembered between opens.
 *
 * A desktop that forgets geometry makes somebody drag every window back into place every time —
 * the machine's system panel belongs at the size it was left at, not back in the middle at the
 * default. The memory is per session and per *kind*, not per window id: a desktop may hold two file
 * windows at once, but "where a file window goes" is one answer, and the last one closed wrote it.
 *
 * The memory lives in the WebView's own storage, beside the icon order and the shortcuts — a device
 * preference, not a session fact: two machines looking at one host may keep different desks, and
 * the vault, which syncs session facts, has no business carrying pixels. A storage that refuses
 * (a WebView without a usable localStorage) costs the memory, not the desktop: windows simply open
 * centred every time, the way they did before this file existed.
 *
 * Writes are debounced, because a drag produces a move event per pointer step and each one would
 * otherwise be a storage write; the caller schedules and this file only shapes the record.
 */

import { clampToWorkArea, type WorkbenchBounds, type WorkbenchWindowRect } from "@/lib/workbench/windows";

/** The storage key, namespaced per session the way the icon order and the shortcuts are. */
const MEMORY_KEY = "sevenshell-workbench-window-memory-v1";

/** One kind's remembered rectangle, as it is stored. */
type StoredRect = { left: number; top: number; width: number; height: number };

/** The whole memory: session id → kind → rectangle. */
type StoredMemory = Record<string, Record<string, StoredRect>>;

/**
 * Reads what this session remembers, as a plain record.
 *
 * Anything unreadable — a missing key, a hand edit, a shape an older build wrote — is the same as
 * remembering nothing: the caller opens the window centred, which is always a correct answer.
 */
export function readWindowMemory(sessionId: string): Record<string, WorkbenchWindowRect> {
  try {
    const raw = localStorage.getItem(MEMORY_KEY);
    if (raw === null) {
      return {};
    }
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) {
      return {};
    }
    const forSession = (parsed as StoredMemory)[sessionId];
    if (typeof forSession !== "object" || forSession === null) {
      return {};
    }
    const memory: Record<string, WorkbenchWindowRect> = {};
    for (const [kind, rect] of Object.entries(forSession)) {
      if (
        typeof rect === "object" &&
        rect !== null &&
        Number.isFinite(rect.left) &&
        Number.isFinite(rect.top) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0
      ) {
        memory[kind] = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      }
    }
    return memory;
  } catch {
    return {};
  }
}

/**
 * Writes one kind's geometry down, leaving the other kinds' memories alone.
 *
 * The write is read-modify-write on the whole record because storage holds one string for every
 * session and kind; the record is small, and the alternative — a key per kind — would leave old
 * sessions' kinds behind forever. A session whose record grows past its kinds' worth is cleaned by
 * the caller forgetting to write, not by anything here.
 */
export function writeWindowMemory(sessionId: string, kind: string, rect: WorkbenchWindowRect): void {
  try {
    const memory: StoredMemory = (() => {
      try {
        const raw = localStorage.getItem(MEMORY_KEY);
        const parsed: unknown = raw === null ? undefined : JSON.parse(raw);
        return typeof parsed === "object" && parsed !== null ? (parsed as StoredMemory) : {};
      } catch {
        return {};
      }
    })();
    memory[sessionId] = {
      ...memory[sessionId],
      [kind]: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
    };
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memory));
  } catch {
    // A storage that refuses costs the memory, not the desktop.
  }
}

/**
 * The rectangle a window of this kind should open at, or nothing to remember it by.
 *
 * The remembered rectangle is clamped into the work area as it is *now*: a desk that shrank since
 * the window was last open must not leave it half off the edge. Clamping is the geometry library's
 * own rule, so the answer here is already the rectangle `openWindow` wants.
 */
export function rememberedRect(
  sessionId: string,
  kind: string,
  bounds: WorkbenchBounds,
): WorkbenchWindowRect | undefined {
  const rect = readWindowMemory(sessionId)[kind];
  if (rect === undefined) {
    return undefined;
  }
  return clampToWorkArea(rect, bounds);
}

/**
 * The geometry worth remembering about a window: a visible one's rectangle.
 *
 * A maximised window's on-screen rectangle is the whole desk — not the window's own geometry, and
 * remembering it would make every later open of this kind fill the desk. The maximised window's
 * `restore` rectangle is where it really was; a minimised window's record is already back at that
 * rectangle (the minimiser rewrote it), so reading the record's own fields is right for both.
 */
export function memorableRect(window: {
  mode: "normal" | "min" | "max";
  left: number;
  top: number;
  width: number;
  height: number;
  restore?: WorkbenchWindowRect;
}): WorkbenchWindowRect | undefined {
  if (window.mode === "max") {
    return window.restore ?? undefined;
  }
  if (window.mode === "min" || window.width <= 0 || window.height <= 0) {
    return undefined;
  }
  return { left: window.left, top: window.top, width: window.width, height: window.height };
}
