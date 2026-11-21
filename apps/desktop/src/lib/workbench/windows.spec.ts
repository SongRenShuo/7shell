/**
 * The window arithmetic: where a window opens, how far it may be dragged, what maximising
 * remembers, and who holds the focus when the holder goes away.
 *
 * The component suite says what a gesture sends; this one says what those numbers mean once they
 * reach the list. Each case is stated against an 800×600 desk, because the boundaries are the
 * whole subject: a clamp that is right in the middle of the desk and wrong at its edge is a window
 * somebody can drag out of reach.
 */
import { describe, expect, it } from "vitest";

import {
  DEFAULT_HEIGHT,
  DEFAULT_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  MIN_VISIBLE_PX,
  SNAP_EDGE_PX,
  STATUS_BAR_HEIGHT,
  TASKBAR_HEIGHT,
  clampToWorkArea,
  closeWindow,
  cycleWindow,
  focusWindow,
  minimizeAll,
  minimizeWindow,
  moveWindow,
  openWindow,
  resizeWindow,
  resizeWindowFrom,
  restoreAll,
  restoreWindow,
  setMaximized,
  showWindow,
  snapRect,
  snapZoneAt,
  snapZoneRect,
  type WorkbenchBounds,
  type WorkbenchWindowState,
} from "./windows";

/** The reference desktop the numbers are checked against. */
const DESK: WorkbenchBounds = { width: 800, height: 600 };

/**
 * The room a window may use.
 *
 * The caller measures the work area — the region between the desktop's status bar and taskbar —
 * and hands that in, so for this arithmetic the bounds *are* the room: no chrome is subtracted
 * twice.
 */
const WORK_TOP = 0;
const WORK_BOTTOM = DESK.height;
const WORK_HEIGHT = WORK_BOTTOM - WORK_TOP;

function windowAt(overrides: Partial<WorkbenchWindowState> = {}): WorkbenchWindowState {
  return {
    id: "w1",
    title: "Terminal",
    kind: "terminal",
    left: 100,
    top: 100,
    width: 666,
    height: 422,
    mode: "normal",
    z: 1,
    focused: true,
    ...overrides,
  };
}

/** Freezes a list so a test can prove the call did not write through its arguments. */
function snapshot(list: readonly WorkbenchWindowState[]): string {
  return JSON.stringify(list);
}

describe("the metrics", () => {
  it("are the desktop's", () => {
    expect([DEFAULT_WIDTH, DEFAULT_HEIGHT, MIN_WIDTH, MIN_HEIGHT]).toEqual([900, 600, 200, 200]);
    expect([STATUS_BAR_HEIGHT, TASKBAR_HEIGHT]).toEqual([23, 57]);
  });
});

describe("clampToWorkArea", () => {
  it("leaves a rectangle that already fits exactly where it was", () => {
    const rect = { left: 60, top: 80, width: 400, height: 300 };

    expect(clampToWorkArea(rect, DESK)).toEqual(rect);
  });

  it("moves a rectangle out from under the status bar and the taskbar", () => {
    expect(clampToWorkArea({ left: -50, top: -50, width: 400, height: 300 }, DESK)).toEqual({
      left: 0,
      top: WORK_TOP,
      width: 400,
      height: 300,
    });

    // The floor is the top of the taskbar, not the bottom of the desk.
    expect(clampToWorkArea({ left: 700, top: 500, width: 400, height: 300 }, DESK)).toEqual({
      left: 400,
      top: WORK_BOTTOM - 300,
      width: 400,
      height: 300,
    });
  });

  it("shrinks a rectangle larger than the desk rather than letting it overflow", () => {
    expect(clampToWorkArea({ left: 0, top: 0, width: 2000, height: 2000 }, DESK)).toEqual({
      left: 0,
      top: WORK_TOP,
      width: DESK.width,
      height: WORK_HEIGHT,
    });
  });

  it("refuses junk geometry instead of producing a NaN rectangle", () => {
    expect(clampToWorkArea({ left: Number.NaN, top: Number.POSITIVE_INFINITY, width: -10, height: -10 }, DESK)).toEqual(
      { left: 0, top: WORK_TOP, width: 0, height: 0 },
    );
  });
});

describe("openWindow", () => {
  it("opens at the default size, centred, on top", () => {
    const roomy: WorkbenchBounds = { width: 1200, height: 800 };
    const [opened] = openWindow([], { id: "w1", title: "Terminal", kind: "terminal", bounds: roomy });

    expect(opened).toMatchObject({
      id: "w1",
      title: "Terminal",
      kind: "terminal",
      mode: "normal",
      focused: true,
      z: 1,
      // (1200 - 900) / 2 and (800 - 600) / 2, both already inside the work area.
      left: 150,
      top: 100,
      width: DEFAULT_WIDTH,
      height: DEFAULT_HEIGHT,
    });
  });

  it("fills a desk smaller than the default rather than overflowing it", () => {
    const [opened] = openWindow([], { id: "w1", title: "Terminal", kind: "terminal", bounds: DESK });

    // The 900×600 default does not fit an 800×600 desk: the clamp is the only answer that never
    // hides a window's own title bar behind the desk's edge.
    expect(opened).toMatchObject({ left: 0, top: WORK_TOP, width: DESK.width, height: DESK.height });
  });

  it("opens at the remembered geometry, clamped into the desk as it is now", () => {
    const [opened] = openWindow([], {
      id: "w1",
      title: "Terminal",
      kind: "terminal",
      bounds: DESK,
      remembered: { left: 700, top: 300, width: 500, height: 400 },
    });

    expect(opened).toMatchObject({ left: 300, top: 200, width: 500, height: 400 });
  });

  it("clamps an out-of-bounds remembered rectangle fully inside a desk that shrank", () => {
    // An old memory written beside a wider desk — its left edge parked off the desk — must come
    // back whole: every edge inside, width included, or the window opens with its title cut off.
    const small: WorkbenchBounds = { width: 400, height: 300 };
    const [opened] = openWindow([], {
      id: "w1",
      title: "Forwards",
      kind: "forwards",
      bounds: small,
      remembered: { left: -300, top: 50, width: 666, height: 422 },
    });

    expect(opened).toMatchObject({ left: 0, top: 0, width: 400, height: 300 });
    expect(opened!.left).toBeGreaterThanOrEqual(0);
    expect(opened!.top).toBeGreaterThanOrEqual(0);
    expect(opened!.left + opened!.width).toBeLessThanOrEqual(small.width);
    expect(opened!.top + opened!.height).toBeLessThanOrEqual(small.height);
  });

  it("ignores junk fields in a remembered rectangle, falling back to the centred default", () => {
    const roomy: WorkbenchBounds = { width: 1200, height: 800 };
    const [opened] = openWindow([], {
      id: "w1",
      title: "Terminal",
      kind: "terminal",
      bounds: roomy,
      remembered: { left: Number.NaN, top: Number.NaN, width: Number.NaN, height: Number.NaN },
    });

    expect(opened).toMatchObject({ left: 150, top: 100, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT });
  });

  it("takes the focus from every window already open", () => {
    const existing = windowAt({ id: "old", focused: true, z: 4 });

    const opened = openWindow([existing], { id: "new", title: "Files", kind: "files", bounds: DESK });

    expect(opened).toHaveLength(2);
    expect(opened[0]?.focused).toBe(false);
    expect(opened[1]?.focused).toBe(true);
    expect(opened[1]?.z).toBe(5);
  });

  it("clamps a desk too short to hold the default window", () => {
    const narrow: WorkbenchBounds = { width: 500, height: 400 };
    const [opened] = openWindow([], { id: "w1", title: "Terminal", kind: "terminal", bounds: narrow });

    // Width shrinks to the desk; the height shrinks to the room the caller measured.
    expect(opened).toMatchObject({
      left: 0,
      top: WORK_TOP,
      width: 500,
      height: 400,
    });
  });

  it("does not open a second copy of an id, and brings a minimised one back", () => {
    const minimized = windowAt({ mode: "min", left: 12, top: 34, z: 3, focused: false });

    const opened = openWindow([minimized], { id: "w1", title: "Terminal", kind: "terminal", bounds: DESK });

    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ mode: "normal", focused: true, z: 4, left: 12, top: 34 });
  });

  it("never writes through its arguments", () => {
    const list = [windowAt()];
    const before = snapshot(list);

    openWindow(list, { id: "w2", title: "Files", kind: "files", bounds: DESK });

    expect(snapshot(list)).toBe(before);
  });
});

describe("focusWindow", () => {
  it("raises the target above everybody and makes it the only focused window", () => {
    const list = [windowAt({ id: "a", z: 1, focused: false }), windowAt({ id: "b", z: 2, focused: true })];

    const focused = focusWindow(list, "a");

    expect(focused[0]).toMatchObject({ id: "a", z: 3, focused: true });
    expect(focused[1]).toMatchObject({ id: "b", z: 2, focused: false });
  });

  it("does not pick up a minimised window", () => {
    const list = [windowAt({ id: "a", mode: "min", z: 9, focused: false }), windowAt({ id: "b", focused: true, z: 1 })];

    const focused = focusWindow(list, "a");

    expect(focused[0]).toMatchObject({ id: "a", mode: "min", z: 9, focused: false });
    expect(focused[1]).toMatchObject({ id: "b", focused: true });
  });

  it("changes nothing when the id names no window", () => {
    const list = [windowAt()];

    expect(focusWindow(list, "gone")).toEqual(list);
  });
});

describe("moveWindow", () => {
  it("moves by the position it is handed", () => {
    const moved = moveWindow([windowAt()], "w1", { left: 250, top: 300 }, DESK);

    expect(moved[0]).toMatchObject({ left: 250, top: 300 });
  });

  it("keeps a strip of title bar on the desk when dragged past the left edge", () => {
    const moved = moveWindow([windowAt()], "w1", { left: -5000, top: 100 }, DESK);

    // The right-hand strip that stays visible is exactly the reachable minimum.
    expect(moved[0]?.left).toBe(-666 + MIN_VISIBLE_PX);
    expect((moved[0]?.left ?? 0) + (moved[0]?.width ?? 0)).toBe(MIN_VISIBLE_PX);
  });

  it("keeps a strip on the desk when dragged past the right edge", () => {
    const moved = moveWindow([windowAt()], "w1", { left: 5000, top: 100 }, DESK);

    expect(moved[0]?.left).toBe(DESK.width - MIN_VISIBLE_PX);
  });

  it("never lets the title bar climb above the status bar", () => {
    const moved = moveWindow([windowAt()], "w1", { left: 100, top: -400 }, DESK);

    expect(moved[0]?.top).toBe(WORK_TOP);
  });

  it("keeps the title bar above the taskbar, so the window stays grabbable", () => {
    const moved = moveWindow([windowAt()], "w1", { left: 100, top: 5000 }, DESK);

    expect(moved[0]?.top).toBe(WORK_BOTTOM - MIN_VISIBLE_PX);
  });

  it("does not move a maximised or minimised window", () => {
    const list = [windowAt({ mode: "max", left: 0, top: WORK_TOP }), windowAt({ id: "w2", mode: "min" })];

    const moved = moveWindow(list, "w1", { left: 200, top: 200 }, DESK);

    expect(moved[0]).toMatchObject({ left: 0, top: WORK_TOP });
    expect(moved[1]).toMatchObject({ left: 100, top: 100 });
  });
});

describe("resizeWindow", () => {
  it("takes the size it is handed", () => {
    const resized = resizeWindow([windowAt()], "w1", { width: 500, height: 300 }, DESK);

    expect(resized[0]).toMatchObject({ left: 100, top: 100, width: 500, height: 300 });
  });

  it("stops at the minimum size", () => {
    const resized = resizeWindow([windowAt()], "w1", { width: 10, height: 10 }, DESK);

    expect(resized[0]).toMatchObject({ width: MIN_WIDTH, height: MIN_HEIGHT });
  });

  it("stops at the desk's edges", () => {
    const resized = resizeWindow([windowAt()], "w1", { width: 5000, height: 5000 }, DESK);

    // From (100, 100): 700px to the right edge, and the work area's floor is at 543.
    expect(resized[0]).toMatchObject({ width: DESK.width - 100, height: WORK_BOTTOM - 100 });
  });

  it("lets the desk win when the desk itself is smaller than the minimum", () => {
    const tiny: WorkbenchBounds = { width: 150, height: 150 };

    const resized = resizeWindow(
      [windowAt({ left: 0, top: WORK_TOP, width: 150, height: 70 })],
      "w1",
      {
        width: 400,
        height: 400,
      },
      tiny,
    );

    // The desk is the smaller of the two on both axes, so it is what the window becomes.
    expect(resized[0]).toMatchObject({ width: 150, height: 150 });
  });
});

describe("maximising and restoring", () => {
  it("fills the work area and remembers the geometry it left", () => {
    const [maxed] = setMaximized([windowAt()], "w1", DESK);

    expect(maxed).toMatchObject({
      left: 0,
      top: WORK_TOP,
      width: DESK.width,
      height: WORK_HEIGHT,
      mode: "max",
      focused: true,
      z: 2,
      restore: { left: 100, top: 100, width: 666, height: 422 },
    });
  });

  it("is a no-op the second time, so restore is not overwritten with the maximised rectangle", () => {
    const once = setMaximized([windowAt()], "w1", DESK);
    const twice = setMaximized(once, "w1", DESK);

    expect(twice[0]?.restore).toEqual({ left: 100, top: 100, width: 666, height: 422 });
    expect(twice[0]).toMatchObject({ mode: "max", left: 0, top: WORK_TOP });
  });

  it("puts the remembered geometry back exactly", () => {
    const maxed = setMaximized([windowAt()], "w1", DESK);
    const [restored] = restoreWindow(maxed, "w1", DESK);

    expect(restored).toMatchObject({
      left: 100,
      top: 100,
      width: 666,
      height: 422,
      mode: "normal",
      focused: true,
      z: 3,
    });
    expect(restored?.restore).toBeUndefined();
  });

  it("clamps a remembered rectangle that hangs off the desk's edge back inside it", () => {
    // A window may be dragged mostly off the desk before it is maximised — the memory keeps that
    // rectangle, and restoring it used to put the window back off the edge, its title half gone.
    const offEdge = windowAt({
      left: -300,
      top: 100,
      width: 666,
      height: 422,
      mode: "max",
      restore: { left: -300, top: 100, width: 666, height: 422 },
    });
    const [restored] = restoreWindow([offEdge], "w1", DESK);

    expect(restored).toMatchObject({ left: 0, top: 100, width: 666, height: 422 });
    expect(restored!.left).toBeGreaterThanOrEqual(0);
    expect(restored!.left + restored!.width).toBeLessThanOrEqual(DESK.width);
  });

  it("clamps a remembered rectangle into a desk that shrank under the maximised window", () => {
    const small: WorkbenchBounds = { width: 400, height: 300 };
    const maxed = windowAt({
      mode: "max",
      left: 0,
      top: 0,
      width: DESK.width,
      height: DESK.height,
      restore: { left: 100, top: 100, width: 666, height: 422 },
    });
    const [restored] = restoreWindow([maxed], "w1", small);

    // The whole window lands inside the smaller desk, width included: nothing hangs off any edge.
    expect(restored).toMatchObject({ left: 0, top: 0, width: 400, height: 300 });
    expect(restored!.left + restored!.width).toBeLessThanOrEqual(small.width);
    expect(restored!.top + restored!.height).toBeLessThanOrEqual(small.height);
  });

  it("is a no-op when the window is already normal", () => {
    const list = [windowAt()];

    expect(restoreWindow(list, "w1", DESK)).toEqual(list);
  });

  it("maximises a minimised window and shows it", () => {
    const minimized = [windowAt({ mode: "min", focused: false })];

    const [maxed] = setMaximized(minimized, "w1", DESK);

    expect(maxed).toMatchObject({ mode: "max", left: 0, top: WORK_TOP, focused: true });
    expect(maxed?.restore).toEqual({ left: 100, top: 100, width: 666, height: 422 });
  });
});

describe("minimising and showing", () => {
  it("keeps the record and its stacking, and hides the window", () => {
    const [minimized] = minimizeWindow([windowAt({ z: 7 })], "w1");

    expect(minimized).toMatchObject({
      mode: "min",
      z: 7,
      left: 100,
      top: 100,
      width: 666,
      height: 422,
      focused: false,
    });
  });

  it("hands the focus to the highest window still visible", () => {
    const list = [
      windowAt({ id: "focused", z: 5, focused: true }),
      windowAt({ id: "next", z: 3, focused: false }),
      windowAt({ id: "hidden", z: 9, mode: "min", focused: false }),
    ];

    const minimized = minimizeWindow(list, "focused");

    expect(minimized[0]?.focused).toBe(false);
    expect(minimized[1]?.focused).toBe(true);
    expect(minimized[2]?.focused).toBe(false);
  });

  it("leaves nothing focused when it was the last visible window", () => {
    const minimized = minimizeWindow([windowAt({ focused: true }), windowAt({ id: "w2", mode: "min" })], "w1");

    expect(minimized.every((window) => !window.focused)).toBe(true);
  });

  it("puts a maximised window's remembered geometry back before hiding it", () => {
    const maxed = setMaximized([windowAt()], "w1", DESK);
    const [minimized] = minimizeWindow(maxed, "w1");

    expect(minimized).toMatchObject({ mode: "min", left: 100, top: 100, width: 666, height: 422 });
  });

  it("brings it back with a new stacking value and the focus", () => {
    const minimized = minimizeWindow([windowAt({ z: 2 })], "w1");
    const [shown] = showWindow(minimized, "w1", DESK);

    expect(shown).toMatchObject({ mode: "normal", focused: true, z: 3, left: 100, top: 100 });
  });

  it("clamps a hidden window whose geometry no longer fits the desk as it is now", () => {
    // Put away on a wider desk, then the desk shrank: showing it must not hand back a window
    // hanging off the edge it was parked beside.
    const hidden = windowAt({ mode: "min", left: -300, top: 100, width: 666, height: 422, focused: false });

    const [shown] = showWindow([hidden], "w1", DESK);

    expect(shown).toMatchObject({ mode: "normal", focused: true, left: 0, top: 100, width: 666, height: 422 });
    expect(shown!.left + shown!.width).toBeLessThanOrEqual(DESK.width);
  });

  it("restoring a minimised window is the same as showing it", () => {
    const minimized = minimizeWindow([windowAt()], "w1");
    const [restored] = restoreWindow(minimized, "w1", DESK);

    expect(restored).toMatchObject({ mode: "normal", focused: true, left: 100, top: 100, width: 666, height: 422 });
  });

  it("brings a visible window forward when asked to show it", () => {
    const list = [windowAt({ id: "a", z: 1, focused: false }), windowAt({ id: "b", z: 2, focused: true })];

    const shown = showWindow(list, "a", DESK);

    expect(shown[0]).toMatchObject({ focused: true, z: 3 });
    expect(shown[1]?.focused).toBe(false);
  });
});

describe("closeWindow", () => {
  it("removes the window and focuses the next-highest visible one", () => {
    const list = [
      windowAt({ id: "a", z: 1, focused: false }),
      windowAt({ id: "b", z: 2, focused: true }),
      windowAt({ id: "c", z: 3, focused: false }),
    ];

    const closed = closeWindow(list, "b");

    expect(closed.map((window) => window.id)).toEqual(["a", "c"]);
    expect(closed[0]?.focused).toBe(false);
    expect(closed[1]?.focused).toBe(true);
  });

  it("skips a minimised window when looking for the next focus", () => {
    const list = [windowAt({ id: "a", z: 1, focused: true }), windowAt({ id: "b", z: 9, mode: "min", focused: false })];

    const closed = closeWindow(list, "a");

    expect(closed[0]?.focused).toBe(false);
  });

  it("leaves the focus alone when closing a window that did not hold it", () => {
    const list = [windowAt({ id: "a", z: 1, focused: true }), windowAt({ id: "b", z: 2, focused: false })];

    const closed = closeWindow(list, "b");

    expect(closed[0]?.focused).toBe(true);
  });

  it("empties the desk when the last window closes", () => {
    expect(closeWindow([windowAt()], "w1")).toEqual([]);
  });

  it("changes nothing for an id that names no window", () => {
    const list = [windowAt()];

    expect(closeWindow(list, "gone")).toEqual(list);
  });
});

describe("the work area boundary", () => {
  it("holds for opening, resizing and maximising on an 800×600 desk", () => {
    const inside = (rect: { left: number; top: number; width: number; height: number }): boolean =>
      rect.left >= 0 &&
      rect.top >= WORK_TOP &&
      rect.left + rect.width <= DESK.width &&
      rect.top + rect.height <= WORK_BOTTOM;

    const [opened] = openWindow([], { id: "w1", title: "Terminal", kind: "terminal", bounds: DESK });
    const [resized] = resizeWindow([windowAt()], "w1", { width: 9999, height: 9999 }, DESK);
    const [maxed] = setMaximized([windowAt()], "w1", DESK);

    expect(inside(opened!)).toBe(true);
    expect(inside(resized!)).toBe(true);
    expect(inside(maxed!)).toBe(true);
  });

  it("keeps a grabbable strip visible at every extreme of a drag", () => {
    const corners = [
      { left: -9999, top: -9999 },
      { left: 9999, top: -9999 },
      { left: -9999, top: 9999 },
      { left: 9999, top: 9999 },
    ];

    for (const corner of corners) {
      const [moved] = moveWindow([windowAt()], "w1", corner, DESK);
      expect(moved!.left).toBeLessThanOrEqual(DESK.width - MIN_VISIBLE_PX);
      expect(moved!.left + moved!.width).toBeGreaterThanOrEqual(MIN_VISIBLE_PX);
      expect(moved!.top).toBeGreaterThanOrEqual(WORK_TOP);
      expect(moved!.top).toBeLessThanOrEqual(WORK_BOTTOM - MIN_VISIBLE_PX);
    }
  });

  it("clamps a window larger than a small viewport instead of overflowing it", () => {
    const small: WorkbenchBounds = { width: 400, height: 300 };
    const [opened] = openWindow([], { id: "w1", title: "Terminal", kind: "terminal", bounds: small });

    expect(opened).toMatchObject({ left: 0, top: WORK_TOP, width: 400, height: 300 });
  });
});

describe("minimizeAll", () => {
  it("puts every visible window away and leaves nothing focused", () => {
    const desk = [
      windowAt({ id: "a", z: 1, focused: true }),
      windowAt({ id: "b", left: 200, top: 200, z: 2, focused: false }),
    ];

    const emptied = minimizeAll(desk);

    expect(emptied.every((window) => window.mode === "min")).toBe(true);
    expect(emptied.every((window) => window.focused === false)).toBe(true);
  });

  it("leaves already-minimised windows untouched", () => {
    const hidden = windowAt({ id: "hidden", mode: "min", left: 40, top: 40, focused: false });
    const visible = windowAt({ id: "shown", focused: true, z: 2 });

    const emptied = minimizeAll([hidden, visible]);

    expect(emptied.find((window) => window.id === "hidden")).toMatchObject({ mode: "min", left: 40, top: 40 });
  });

  it("answers a copy of an already-empty desk", () => {
    const desk = [windowAt({ mode: "min" })];
    const snapshot = JSON.stringify(desk);
    const emptied = minimizeAll(desk);
    expect(JSON.stringify(emptied)).toBe(snapshot);
  });
});

describe("restoreAll", () => {
  it("brings every minimised window back, focus ending with the last one raised", () => {
    const desk = [
      windowAt({ id: "a", mode: "min", left: 10, top: 10, focused: false }),
      windowAt({ id: "b", mode: "min", left: 20, top: 20, focused: false }),
      windowAt({ id: "c", z: 3, focused: true }),
    ];

    const restored = restoreAll(desk, DESK);

    expect(restored.find((window) => window.id === "a")).toMatchObject({ mode: "normal" });
    expect(restored.find((window) => window.id === "b")).toMatchObject({ mode: "normal", focused: true });
    expect(restored.find((window) => window.id === "c")).toMatchObject({ mode: "normal", focused: false });
  });

  it("clamps every hidden window into the desk as it is now", () => {
    const desk = [
      windowAt({ id: "a", mode: "min", left: -300, top: 10, width: 666, height: 422, focused: false }),
      windowAt({ id: "b", mode: "min", left: 10, top: 20, width: 900, height: 700, focused: false }),
    ];

    const restored = restoreAll(desk, DESK);

    for (const window of restored) {
      expect(window.left).toBeGreaterThanOrEqual(0);
      expect(window.top).toBeGreaterThanOrEqual(WORK_TOP);
      expect(window.left + window.width).toBeLessThanOrEqual(DESK.width);
      expect(window.top + window.height).toBeLessThanOrEqual(WORK_BOTTOM);
    }
    expect(restored.find((window) => window.id === "a")).toMatchObject({ left: 0, width: 666 });
    expect(restored.find((window) => window.id === "b")).toMatchObject({ width: DESK.width, height: DESK.height });
  });

  it("leaves visible windows alone on an already-open desk", () => {
    const desk = [windowAt({ focused: true })];
    const snapshot = JSON.stringify(desk);
    const restored = restoreAll(desk, DESK);
    expect(JSON.stringify(restored)).toBe(snapshot);
  });

  it("does not write through its arguments", () => {
    const desk = [windowAt({ mode: "min", focused: false })];
    const snapshot = JSON.stringify(desk);
    restoreAll(desk, DESK);
    expect(JSON.stringify(desk)).toBe(snapshot);
  });
});

describe("resizeWindowFrom", () => {
  it("resizes from the south edge and keeps the top-left corner where it was", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "s", { left: 100, top: 100, width: 666, height: 500 }, DESK);

    expect(resized).toMatchObject({ left: 100, top: 100, width: 666, height: 500 });
  });

  it("resizes from the east edge, stopped by the desk's right edge", () => {
    const [resized] = resizeWindowFrom(
      [windowAt()],
      "w1",
      "e",
      { left: 100, top: 100, width: 9999, height: 422 },
      DESK,
    );

    expect(resized).toMatchObject({ left: 100, width: DESK.width - 100 });
  });

  it("resizes from the west edge: the right edge stays put while the left follows the pointer", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "w", { left: 40, top: 100, width: 726, height: 422 }, DESK);

    // right = 100 + 666 = 766, unchanged; width grew by the 60 the left moved.
    expect(resized).toMatchObject({ left: 40, width: 726 });
  });

  it("pulls the left edge back when the west drag asks for less than the minimum", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "w", { left: 600, top: 100, width: 166, height: 422 }, DESK);

    // right = 766 is anchored; the minimum is what the width keeps, so the left yields to it.
    expect(resized).toMatchObject({ left: 766 - MIN_WIDTH, width: MIN_WIDTH });
  });

  it("never lets a west drag push the left past the desk's left edge", () => {
    const [resized] = resizeWindowFrom(
      [windowAt()],
      "w1",
      "w",
      { left: -500, top: 100, width: 1266, height: 422 },
      DESK,
    );

    expect(resized).toMatchObject({ left: 0, width: 766 });
  });

  it("resizes from the north edge: the bottom edge stays put while the top follows the pointer", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "n", { left: 100, top: 40, width: 666, height: 482 }, DESK);

    // bottom = 100 + 422 = 522, unchanged.
    expect(resized).toMatchObject({ top: 40, height: 482 });
  });

  it("pulls the top edge back when the north drag asks for less than the minimum", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "n", { left: 100, top: 450, width: 666, height: 72 }, DESK);

    expect(resized).toMatchObject({ top: 522 - MIN_HEIGHT, height: MIN_HEIGHT });
  });

  it("never lets a north drag push the top above the work area", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "n", { left: 100, top: -80, width: 666, height: 602 }, DESK);

    expect(resized).toMatchObject({ top: 0, height: 522 });
  });

  it("resizes from a corner as both of its edges at once", () => {
    const [resized] = resizeWindowFrom([windowAt()], "w1", "nw", { left: 20, top: 20, width: 746, height: 502 }, DESK);

    expect(resized).toMatchObject({ left: 20, top: 20, width: 746, height: 502 });
  });

  it("stops a south drag at the desk's bottom edge", () => {
    const [resized] = resizeWindowFrom(
      [windowAt()],
      "w1",
      "se",
      { left: 100, top: 100, width: 900, height: 9999 },
      DESK,
    );

    expect(resized).toMatchObject({ width: 700, height: 500 });
  });

  it("leaves a maximised or minimised window where it is", () => {
    const maximised = windowAt({ mode: "max" });
    const before = JSON.stringify([maximised]);
    const [resized] = resizeWindowFrom([maximised], "w1", "e", { left: 0, top: 0, width: 40, height: 40 }, DESK);

    expect(JSON.stringify([resized])).toBe(before);
  });

  it("does not write through its arguments", () => {
    const desk = [windowAt()];
    const before = JSON.stringify(desk);
    resizeWindowFrom(desk, "w1", "w", { left: 0, top: 0, width: 500, height: 500 }, DESK);
    expect(JSON.stringify(desk)).toBe(before);
  });
});

describe("snapZoneAt", () => {
  it("answers left and right for the edge middles", () => {
    expect(snapZoneAt({ left: SNAP_EDGE_PX, top: 300 }, DESK)).toBe("left");
    expect(snapZoneAt({ left: DESK.width - SNAP_EDGE_PX, top: 300 }, DESK)).toBe("right");
  });

  it("answers the four corners as quarters", () => {
    expect(snapZoneAt({ left: 0, top: 0 }, DESK)).toBe("top-left");
    expect(snapZoneAt({ left: DESK.width - 1, top: SNAP_EDGE_PX }, DESK)).toBe("top-right");
    expect(snapZoneAt({ left: SNAP_EDGE_PX, top: DESK.height - 1 }, DESK)).toBe("bottom-left");
    expect(snapZoneAt({ left: DESK.width - 1, top: DESK.height - 1 }, DESK)).toBe("bottom-right");
  });

  it("answers nothing in the middle of the desk", () => {
    expect(snapZoneAt({ left: 400, top: 300 }, DESK)).toBeNull();
  });

  it("answers nothing for the top edge's middle, which is the maximise gesture", () => {
    expect(snapZoneAt({ left: 400, top: 0 }, DESK)).toBeNull();
  });

  it("answers nothing on a desk with no room", () => {
    expect(snapZoneAt({ left: 0, top: 0 }, { width: 0, height: 0 })).toBeNull();
  });
});

describe("snapZoneRect", () => {
  it("fills half the desk for the edge zones, quarter for the corners", () => {
    expect(snapZoneRect("left", DESK)).toEqual({ left: 0, top: 0, width: 400, height: 600 });
    expect(snapZoneRect("right", DESK)).toEqual({ left: 400, top: 0, width: 400, height: 600 });
    expect(snapZoneRect("top-left", DESK)).toEqual({ left: 0, top: 0, width: 400, height: 300 });
    expect(snapZoneRect("top-right", DESK)).toEqual({ left: 400, top: 0, width: 400, height: 300 });
    expect(snapZoneRect("bottom-left", DESK)).toEqual({ left: 0, top: 300, width: 400, height: 300 });
    expect(snapZoneRect("bottom-right", DESK)).toEqual({ left: 400, top: 300, width: 400, height: 300 });
  });
});

describe("snapRect", () => {
  it("puts the window exactly into the zone rectangle", () => {
    const [snapped] = snapRect([windowAt()], "w1", "left", DESK);

    expect(snapped).toMatchObject({ left: 0, top: 0, width: 400, height: 600, mode: "normal" });
  });

  it("remembers where the hand had put it, the way maximising remembers", () => {
    const [snapped] = snapRect([windowAt()], "w1", "right", DESK);

    expect(snapped?.restore).toEqual({ left: 100, top: 100, width: 666, height: 422 });
  });

  it("does not overwrite a memory somebody else already wrote", () => {
    const remembered = windowAt({ restore: { left: 5, top: 5, width: 100, height: 100 } });
    const [snapped] = snapRect([remembered], "w1", "left", DESK);

    expect(snapped?.restore).toEqual({ left: 5, top: 5, width: 100, height: 100 });
  });

  it("brings the snapped window forward and focuses it", () => {
    const desk = [windowAt({ id: "a", z: 1, focused: true }), windowAt({ id: "b", z: 2, focused: false, left: 200 })];
    const snapped = snapRect(desk, "b", "bottom-right", DESK);

    expect(snapped.find((window) => window.id === "b")?.focused).toBe(true);
    expect(snapped.find((window) => window.id === "a")?.focused).toBe(false);
    expect(snapped.find((window) => window.id === "b")?.z).toBe(3);
  });

  it("does not snap a maximised or minimised window", () => {
    const maximised = windowAt({ mode: "max" });
    const before = JSON.stringify([maximised]);
    const [snapped] = snapRect([maximised], "w1", "left", DESK);

    expect(JSON.stringify([snapped])).toBe(before);
  });

  it("does not write through its arguments", () => {
    const desk = [windowAt()];
    const before = JSON.stringify(desk);
    snapRect(desk, "w1", "left", DESK);
    expect(JSON.stringify(desk)).toBe(before);
  });
});

describe("cycleWindow", () => {
  it("hands the focus down the stack, from the front to the window focused just before it", () => {
    const desk = [
      windowAt({ id: "low", z: 1, focused: false }),
      windowAt({ id: "mid", z: 2, focused: false, left: 200 }),
      windowAt({ id: "top", z: 3, focused: true, left: 300 }),
    ];

    const cycled = cycleWindow(desk);

    expect(cycled.find((window) => window.id === "mid")?.focused).toBe(true);
    expect(cycled.find((window) => window.id === "top")?.focused).toBe(false);
  });

  it("wraps from the bottom of the pile back to the front", () => {
    const desk = [
      windowAt({ id: "low", z: 1, focused: true }),
      windowAt({ id: "mid", z: 2, focused: false, left: 200 }),
    ];

    const cycled = cycleWindow(desk);

    expect(cycled.find((window) => window.id === "mid")?.focused).toBe(true);
  });

  it("walks the other way with Shift, and starts at the bottom when nothing is focused", () => {
    const desk = [
      windowAt({ id: "low", z: 1, focused: false }),
      windowAt({ id: "mid", z: 2, focused: false, left: 200 }),
      windowAt({ id: "top", z: 3, focused: false, left: 300 }),
    ];

    const cycled = cycleWindow(desk, true);

    expect(cycled.find((window) => window.id === "low")?.focused).toBe(true);
  });

  it("does not raise a minimised window", () => {
    const desk = [
      windowAt({ id: "hidden", mode: "min", focused: false, z: 2 }),
      windowAt({ id: "top", focused: true, z: 3 }),
    ];

    const cycled = cycleWindow(desk);

    expect(cycled.find((window) => window.id === "hidden")?.focused).toBe(false);
    expect(cycled.find((window) => window.id === "hidden")?.mode).toBe("min");
    expect(cycled.find((window) => window.id === "top")?.focused).toBe(true);
  });

  it("changes nothing on a desk with nothing visible", () => {
    const desk = [windowAt({ mode: "min", focused: false })];
    const before = JSON.stringify(desk);
    const cycled = cycleWindow(desk);

    expect(JSON.stringify(cycled)).toBe(before);
  });
});
