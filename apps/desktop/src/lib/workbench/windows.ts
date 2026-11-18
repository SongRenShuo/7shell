/**
 * The windows a desktop session opens, and the arithmetic that keeps them placeable.
 *
 * A window here is a record, not a component: where it sits, how big it is, which of the three
 * modes it is in, and where it stacks against the others. Everything is a pure function over a
 * list of those records, so the caller can keep them in a `ref`, write them through a store, or
 * hand them down as props without any of that being this file's concern. Nothing here mutates its
 * arguments: every answer is a new list and new records.
 *
 * The metrics are the reference desktop's, measured off its own stylesheet rather than invented:
 * a window opens at 666×422, never goes below 200×200, and the desk has a 23px status bar at the
 * top and a 57px taskbar at the bottom. The taskbar floats a little above the bottom edge in the
 * reference; its height is what matters to the arithmetic here, because the work area is the room
 * between the two bars — a window maximised into that room is supposed to stop above the taskbar,
 * not slide under it.
 *
 * Focus is a boolean on each record, kept as an invariant: at most one window carries it, and it
 * is always a window that is not minimised. It is *not* derived from `z` on the fly, because a
 * minimised window keeps its `z` (the plan asks for that), so "highest z is focused" would keep
 * pointing at something the person just put away. Every function that raises a window also moves
 * the flag, and closing or minimising the focused window hands the flag to the next-highest
 * visible one.
 */

/** The mode a window is drawn in. "min" keeps the record and its geometry; "max" fills the work area. */
export type WindowMode = "normal" | "min" | "max";

/** A rectangle in desktop coordinates: pixels from the desktop's top-left corner. */
export interface WorkbenchWindowRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The size of the surface the windows live on, which is all the clamping needs to know. */
export interface WorkbenchBounds {
  width: number;
  height: number;
}

/** One window: what it is, where it is, and how it stacks. */
export interface WorkbenchWindowState {
  id: string;
  title: string;
  /**
   * What the window carries, in the caller's vocabulary. This file never reads it — a terminal and
   * a file browser are the same rectangle to the arithmetic — so it stays a plain string.
   */
  kind: string;
  left: number;
  top: number;
  width: number;
  height: number;
  mode: WindowMode;
  /** Stacking order. Higher is nearer; the focused window always has the highest value. */
  z: number;
  /** Whether this is the window the pointer last activated. At most one record carries it. */
  focused: boolean;
  /** Where the window was before it was maximised: the geometry `restoreWindow` puts back. */
  restore?: WorkbenchWindowRect;
}

/** The desktop's opening size, which is also the size a window is remembered at. */
export const DEFAULT_WIDTH = 900;
export const DEFAULT_HEIGHT = 600;

/** No window may be made smaller than this, except where the desk itself is smaller. */
export const MIN_WIDTH = 200;
export const MIN_HEIGHT = 200;

/** The bar along the top of the desk. A window's title bar never goes above it. */
export const STATUS_BAR_HEIGHT = 23;

/** The bar along the bottom of the desk. The work area stops above it. */
export const TASKBAR_HEIGHT = 57;

/**
 * How much of a window has to stay reachable when it is dragged mostly off the desk.
 *
 * The title bar is 45px tall, so 48 leaves the whole grip visible: a window whose title bar cannot
 * be reached cannot be moved back, and that is a window somebody has lost.
 */
export const MIN_VISIBLE_PX = 48;

/** What `openWindow` needs to know: the identity and the surface it opens onto. */
export interface OpenWindowInput {
  id: string;
  title: string;
  kind: string;
  bounds: WorkbenchBounds;
  /**
   * Where the window was last time this kind of window was open, which `openWindow` puts it back
   * at. Absent — a kind never opened on this machine — means the centred default.
   */
  remembered?: WorkbenchWindowRect;
}

/** The room the desk actually offers: below the status bar and above the taskbar. */
interface WorkArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
  width: number;
  height: number;
}

/**
 * A number that can be used as a coordinate, or a fallback.
 *
 * Geometry can arrive from storage that a later build or a hand edit wrote, and a `NaN` in one
 * field would otherwise poison every comparison it touches — the window would render nowhere and
 * every clamp would silently answer `NaN`.
 */
function finite(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(Math.max(value, low), high);
}

/** The room between the two bars. A surface too small to hold both collapses to nothing. */
/**
 * The room a window may use: the bounds themselves.
 *
 * `bounds` is the work area the caller draws windows in, not the whole window of the application —
 * the desktop shell measures the region between its status bar and its taskbar and hands that in.
 * The reference's two chrome heights are exported above because they are the shape of that region,
 * but subtracting them here would subtract them twice: once by the shell that measured, and once
 * again by this arithmetic.
 */
function workAreaOf(bounds: WorkbenchBounds): WorkArea {
  const width = Math.max(0, finite(bounds.width, 0));
  const height = Math.max(0, finite(bounds.height, 0));
  return { left: 0, top: 0, right: width, bottom: height, width, height };
}

/** A copy deep enough that a caller holding the old list cannot be surprised by a shared record. */
function copyWindow(window: WorkbenchWindowState): WorkbenchWindowState {
  return {
    ...window,
    restore: window.restore === undefined ? undefined : { ...window.restore },
  };
}

function copyList(list: readonly WorkbenchWindowState[]): WorkbenchWindowState[] {
  return list.map(copyWindow);
}

/** The highest stacking value in the list, so the next raise is above everything already there. */
function topZ(list: readonly WorkbenchWindowState[]): number {
  return list.reduce((highest, window) => Math.max(highest, finite(window.z, 0)), 0);
}

/**
 * Hands the focus to the highest window that can take it, and takes it from everybody else.
 *
 * Minimised windows are skipped: the plan asks a minimised window to keep its `z`, so ignoring the
 * mode here would light a window that is not on screen and leave nothing focused that is.
 * `exceptId` is for minimising or closing the current holder without letting it win the search.
 */
function focusHighest(list: readonly WorkbenchWindowState[], exceptId?: string): WorkbenchWindowState[] {
  let best: WorkbenchWindowState | undefined;
  for (const window of list) {
    if (window.id === exceptId || window.mode === "min") {
      continue;
    }
    if (best === undefined || finite(window.z, 0) > finite(best.z, 0)) {
      best = window;
    }
  }
  return list.map((window) => ({ ...copyWindow(window), focused: window === best }));
}

/**
 * Clamps a rectangle into the work area.
 *
 * Size and position are both clamped, and the size is clamped first: a rectangle wider than the
 * desk has no position that would fit it, so shrinking it is the only answer that never overflows.
 * The minimum a window may be, which belongs to `resizeWindow`, is deliberately not this
 * function's business: on a desk narrower than 200px the desk wins, and a window that respected
 * the minimum there would hang off the edge.
 */
export function clampToWorkArea(rect: WorkbenchWindowRect, bounds: WorkbenchBounds): WorkbenchWindowRect {
  const area = workAreaOf(bounds);
  const width = Math.min(Math.max(0, finite(rect.width, 0)), area.width);
  const height = Math.min(Math.max(0, finite(rect.height, 0)), area.height);
  return {
    left: clamp(finite(rect.left, area.left), area.left, area.left + area.width - width),
    top: clamp(finite(rect.top, area.top), area.top, area.top + area.height - height),
    width,
    height,
  };
}

/**
 * Opens a window at its remembered geometry, or centred at the default size, on top of everything.
 *
 * A remembered rectangle — the geometry this kind of window was last left at on this machine — is
 * what a reopened window comes back to, clamped into the work area as it is now: a desk that got
 * smaller must not leave a window half off it. Without one, the centre is taken over the whole desk
 * and then clamped into the work area, which is what makes a short surface push the window down out
 * from under the status bar rather than half behind it. A window larger than the work area is
 * shrunk to it — an opening window that overflows the desk would hide its own title bar before
 * anybody had a chance to move it.
 *
 * Opening an id that is already open does not open a second one: it brings the existing window
 * forward, which for a minimised one means showing it again. The geometry is left where the person
 * last put it, because "open" on something already open is a request to look at it, not a request
 * to send it back to the middle.
 */
export function openWindow(list: readonly WorkbenchWindowState[], input: OpenWindowInput): WorkbenchWindowState[] {
  if (list.some((window) => window.id === input.id)) {
    return showWindow(list, input.id);
  }
  const wanted = input.remembered ?? {
    left: (finite(input.bounds.width, DEFAULT_WIDTH) - DEFAULT_WIDTH) / 2,
    top: (finite(input.bounds.height, DEFAULT_HEIGHT) - DEFAULT_HEIGHT) / 2,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
  const rect = clampToWorkArea(
    {
      left: finite(wanted.left, (finite(input.bounds.width, DEFAULT_WIDTH) - DEFAULT_WIDTH) / 2),
      top: finite(wanted.top, (finite(input.bounds.height, DEFAULT_HEIGHT) - DEFAULT_HEIGHT) / 2),
      width: finite(wanted.width, DEFAULT_WIDTH),
      height: finite(wanted.height, DEFAULT_HEIGHT),
    },
    input.bounds,
  );
  const opened: WorkbenchWindowState = {
    id: input.id,
    title: input.title,
    kind: input.kind,
    ...rect,
    mode: "normal",
    z: topZ(list) + 1,
    focused: true,
  };
  return [...list.map((window) => ({ ...copyWindow(window), focused: false })), opened];
}

/**
 * Raises a window and makes it the focused one.
 *
 * A minimised window is left where it is: it is not on screen to be clicked, and showing it is a
 * separate ask (`showWindow`). An id that names nothing is a no-op, not an error — a gesture can
 * outlive the window it was aimed at.
 */
export function focusWindow(list: readonly WorkbenchWindowState[], id: string): WorkbenchWindowState[] {
  const target = list.find((window) => window.id === id);
  if (target === undefined || target.mode === "min") {
    return copyList(list);
  }
  const z = topZ(list) + 1;
  return list.map((window) => ({
    ...copyWindow(window),
    focused: window.id === id,
    z: window.id === id ? z : window.z,
  }));
}

/**
 * Moves a window, leaving enough of it on the desk to be picked up again.
 *
 * Moving is clamped differently from resizing: a window may hang off the right or bottom edge —
 * that is what dragging it there means — but a strip of the title bar has to stay inside the work
 * area horizontally, and the title bar may never cross above the status bar or below the point
 * where it would be buried under the taskbar. The top edge stopping at the status bar is also what
 * makes "drag it to the top" a deliberate gesture in `WorkbenchWindow.vue` rather than an accident
 * of a move that went too far.
 *
 * A maximised or minimised window is not moved: its geometry is not what is on screen, and moving
 * it would quietly change where it restores to.
 */
export function moveWindow(
  list: readonly WorkbenchWindowState[],
  id: string,
  position: { left: number; top: number },
  bounds: WorkbenchBounds,
): WorkbenchWindowState[] {
  const area = workAreaOf(bounds);
  return list.map((window) => {
    if (window.id !== id || window.mode !== "normal") {
      return copyWindow(window);
    }
    const width = Math.max(0, finite(window.width, 0));
    const visibleX = Math.min(MIN_VISIBLE_PX, width);
    const visibleY = Math.min(MIN_VISIBLE_PX, Math.max(0, finite(window.height, 0)));
    return {
      ...copyWindow(window),
      left: clamp(finite(position.left, window.left), area.left + visibleX - width, area.right - visibleX),
      top: clamp(finite(position.top, window.top), area.top, area.bottom - visibleY),
    };
  });
}

/**
 * Resizes a window, honouring the minimum and the desk's own edges.
 *
 * The top-left corner stays where it was — a resize is a change of size, not a move — so the size
 * is capped by the room from that corner to the right and bottom edges rather than by the whole
 * work area. The minimum loses only when the desk itself is smaller than it: a 200×200 window on a
 * 150px-tall work area would overflow, and not overflowing is the stronger promise.
 */
export function resizeWindow(
  list: readonly WorkbenchWindowState[],
  id: string,
  size: { width: number; height: number },
  bounds: WorkbenchBounds,
): WorkbenchWindowState[] {
  const area = workAreaOf(bounds);
  return list.map((window) => {
    if (window.id !== id || window.mode !== "normal") {
      return copyWindow(window);
    }
    const roomWidth = Math.min(area.width, Math.max(0, area.right - window.left));
    const roomHeight = Math.min(area.height, Math.max(0, area.bottom - window.top));
    return {
      ...copyWindow(window),
      width: Math.min(Math.max(MIN_WIDTH, finite(size.width, window.width)), roomWidth),
      height: Math.min(Math.max(MIN_HEIGHT, finite(size.height, window.height)), roomHeight),
    };
  });
}

/**
 * Maximises a window: remembers where it was, then fills the work area.
 *
 * The remembered geometry is the whole point of the mode. Maximising twice is a no-op rather than
 * a second remember, which would overwrite the original with the maximised rectangle and make
 * "restore" a button that does nothing.
 *
 * A minimised window can be maximised, and it is shown while doing so: maximising is a request to
 * look at the window at the largest size, and a hidden window would answer it with nothing.
 */
export function setMaximized(
  list: readonly WorkbenchWindowState[],
  id: string,
  bounds: WorkbenchBounds,
): WorkbenchWindowState[] {
  const target = list.find((window) => window.id === id);
  if (target === undefined || target.mode === "max") {
    return copyList(list);
  }
  const area = workAreaOf(bounds);
  const restore: WorkbenchWindowRect = {
    left: target.left,
    top: target.top,
    width: target.width,
    height: target.height,
  };
  const z = topZ(list) + 1;
  return list.map((window) => {
    if (window.id !== id) {
      return { ...copyWindow(window), focused: false };
    }
    return {
      ...copyWindow(window),
      left: area.left,
      top: area.top,
      width: area.width,
      height: area.height,
      mode: "max",
      restore,
      focused: true,
      z,
    };
  });
}

/**
 * Puts a window back to its remembered geometry.
 *
 * The remembered rectangle is applied exactly, not clamped against the desk as it is now: somebody
 * who maximised on a wide desk and restored after the window got narrower expects the window where
 * they left it, and silently rewriting it would make the memory a lie. The caller clamps when it
 * draws a window that no longer fits; this function's contract is the geometry it was told.
 *
 * Restoring a minimised window is the same request as showing it — both mean "put it back on the
 * desk" — so it delegates rather than growing a second notion of restored-but-hidden. Restoring a
 * window that is already normal is a no-op, which is what makes the second click of a
 * maximise/restore button harmless.
 */
export function restoreWindow(list: readonly WorkbenchWindowState[], id: string): WorkbenchWindowState[] {
  const target = list.find((window) => window.id === id);
  if (target === undefined || target.mode === "normal") {
    return copyList(list);
  }
  if (target.mode === "min") {
    return showWindow(list, id);
  }
  const restored = target.restore ?? {
    left: target.left,
    top: target.top,
    width: target.width,
    height: target.height,
  };
  const z = topZ(list) + 1;
  return list.map((window) => {
    if (window.id !== id) {
      return { ...copyWindow(window), focused: false };
    }
    return {
      ...copyWindow(window),
      ...restored,
      mode: "normal",
      restore: undefined,
      focused: true,
      z,
    };
  });
}

/**
 * Minimises a window: the record and its stacking stay, the geometry goes back to normal size.
 *
 * A maximised window is put back to its remembered rectangle on the way out. Its full-desk geometry
 * belongs to the maximised mode, and leaving it in place would mean the window came back from the
 * taskbar as a normal window the size of the desk — with the restore button gone, because it is no
 * longer maximised.
 *
 * Minimising the focused window hands the focus to the next-highest visible one, the way closing it
 * would: a desktop where nothing is focused after somebody puts a window away reads as if the
 * remaining windows stopped answering.
 */
export function minimizeWindow(list: readonly WorkbenchWindowState[], id: string): WorkbenchWindowState[] {
  const target = list.find((window) => window.id === id);
  if (target === undefined || target.mode === "min") {
    return copyList(list);
  }
  const geometry = target.mode === "max" && target.restore !== undefined ? target.restore : target;
  const minimized = list.map((window) => {
    if (window.id !== id) {
      return copyWindow(window);
    }
    return {
      ...copyWindow(window),
      left: geometry.left,
      top: geometry.top,
      width: geometry.width,
      height: geometry.height,
      mode: "min" as const,
      restore: undefined,
      focused: false,
    };
  });
  return target.focused ? focusHighest(minimized, id) : minimized;
}

/**
 * Brings a window back to the desk at its remembered geometry, with a fresh stacking value.
 *
 * A window that was not minimised is simply focused: "show" on something already visible is the
 * same request as "bring it forward", and refusing it would make the taskbar button of a visible
 * window dead.
 */
export function showWindow(list: readonly WorkbenchWindowState[], id: string): WorkbenchWindowState[] {
  const target = list.find((window) => window.id === id);
  if (target === undefined) {
    return copyList(list);
  }
  if (target.mode !== "min") {
    return focusWindow(list, id);
  }
  const z = topZ(list) + 1;
  return list.map((window) => {
    if (window.id !== id) {
      return { ...copyWindow(window), focused: false };
    }
    return { ...copyWindow(window), mode: "normal", focused: true, z };
  });
}

/**
 * Closes a window and leaves the next-highest one focused.
 *
 * "Next-highest" means the highest stacking value among the windows that are still visible — a
 * minimised window is skipped, because closing the active window should not light one that is put
 * away. Closing a window that was not focused leaves the focus where it was. Closing the last
 * window leaves nothing focused, which is a desk with nothing on it and exactly right.
 */
export function closeWindow(list: readonly WorkbenchWindowState[], id: string): WorkbenchWindowState[] {
  const target = list.find((window) => window.id === id);
  if (target === undefined) {
    return copyList(list);
  }
  const remaining = list.filter((window) => window.id !== id).map(copyWindow);
  return target.focused ? focusHighest(remaining) : remaining;
}

/**
 * Minimises every window that is on screen, the desktop button's first half.
 *
 * Each visible window goes through the same `minimizeWindow` path a single one would — same
 * remembered rectangle, same focus hand-over — so the desk empties the same way one window at a
 * time does, ending with nothing focused because nothing is visible. Already-minimised windows are
 * left exactly as they are: their geometry was not on screen to change.
 */
export function minimizeAll(list: readonly WorkbenchWindowState[]): WorkbenchWindowState[] {
  const visible = list.some((window) => window.mode !== "min");
  if (!visible) {
    return copyList(list);
  }
  return list.reduce(
    (current, window) => (window.mode === "min" ? current : minimizeWindow(current, window.id)),
    copyList(list),
  );
}

/**
 * Puts every minimised window back on the desk, the desktop button's second half.
 *
 * The windows come back stacked in the order the list keeps them, each raise leaving the focus with
 * the last — the top of the pile is where the pointer goes next, and that is as good a guess as the
 * list offers. Windows that were never put away are untouched: "restore the desk" means bringing
 * back what was hidden, not rearranging what was never hidden.
 */
export function restoreAll(list: readonly WorkbenchWindowState[]): WorkbenchWindowState[] {
  const hidden = list.some((window) => window.mode === "min");
  if (!hidden) {
    return copyList(list);
  }
  return list.reduce(
    (current, window) => (window.mode === "min" ? showWindow(current, window.id) : current),
    copyList(list),
  );
}
