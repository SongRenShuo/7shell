/**
 * The window memory's own rules: what is written, what a later reader accepts, and what a shape an
 * older build or a hand edit left behind means.
 *
 * The pane's suite says when the memory is consulted and written; what can only be seen here is the
 * record's arithmetic — the per-kind read-modify-write that leaves other kinds' memories alone, the
 * junk a reader refuses rather than clamps, and the maximised window that remembers where it really
 * was instead of the desk it covered.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { memorableRect, readWindowMemory, rememberedRect, writeWindowMemory } from "./windowMemory";
import { clampToWorkArea } from "./windows";

const SESSION = "session-1";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("writeWindowMemory / readWindowMemory", () => {
  it("round-trips one kind's rectangle", () => {
    writeWindowMemory(SESSION, "system", { left: 40, top: 60, width: 800, height: 500 });
    expect(readWindowMemory(SESSION)).toEqual({ system: { left: 40, top: 60, width: 800, height: 500 } });
  });

  it("keeps other kinds' and other sessions' memories when writing one kind", () => {
    writeWindowMemory(SESSION, "system", { left: 10, top: 10, width: 700, height: 450 });
    writeWindowMemory(SESSION, "monitor", { left: 30, top: 40, width: 600, height: 400 });
    writeWindowMemory("session-2", "system", { left: 50, top: 50, width: 500, height: 300 });
    expect(readWindowMemory(SESSION)).toEqual({
      system: { left: 10, top: 10, width: 700, height: 450 },
      monitor: { left: 30, top: 40, width: 600, height: 400 },
    });
    expect(readWindowMemory("session-2").system).toEqual({ left: 50, top: 50, width: 500, height: 300 });
  });

  it("rounds fractional coordinates so the stored record stays whole", () => {
    writeWindowMemory(SESSION, "files", { left: 12.4, top: 33.6, width: 500.5, height: 400.5 });
    expect(readWindowMemory(SESSION).files).toEqual({ left: 12, top: 34, width: 501, height: 401 });
  });

  it("answers an empty record for a session it has never heard of", () => {
    expect(readWindowMemory("nobody")).toEqual({});
  });

  it("refuses junk shapes instead of drawing from them", () => {
    localStorage.setItem(
      "sevenshell-workbench-window-memory-v1",
      JSON.stringify({
        [SESSION]: {
          good: { left: 1, top: 2, width: 3, height: 4 },
          nan: { left: Number.NaN, top: 2, width: 3, height: 4 },
          empty: { left: 1, top: 2, width: 0, height: 0 },
          notAnObject: 7,
        },
        junk: "nope",
      }),
    );
    expect(readWindowMemory(SESSION)).toEqual({ good: { left: 1, top: 2, width: 3, height: 4 } });
  });

  it("answers nothing when storage holds an unparseable string", () => {
    localStorage.setItem("sevenshell-workbench-window-memory-v1", "{not json");
    expect(readWindowMemory(SESSION)).toEqual({});
  });

  it("rebuilds the record when storage holds junk, keeping the new write", () => {
    localStorage.setItem("sevenshell-workbench-window-memory-v1", "{not json");
    writeWindowMemory(SESSION, "system", { left: 5, top: 5, width: 600, height: 400 });
    expect(readWindowMemory(SESSION).system).toEqual({ left: 5, top: 5, width: 600, height: 400 });
  });
});

describe("rememberedRect", () => {
  const BOUNDS = { width: 1024, height: 700 };

  it("answers nothing for a kind the session never left behind", () => {
    expect(rememberedRect(SESSION, "system", BOUNDS)).toBeUndefined();
  });

  it("clamps the remembered rectangle into the work area as it is now", () => {
    writeWindowMemory(SESSION, "system", { left: 900, top: 500, width: 800, height: 500 });
    expect(rememberedRect(SESSION, "system", BOUNDS)).toEqual(
      clampToWorkArea({ left: 900, top: 500, width: 800, height: 500 }, BOUNDS),
    );
  });
});

describe("memorableRect", () => {
  it("remembers a normal window's own rectangle", () => {
    expect(memorableRect({ mode: "normal", left: 20, top: 30, width: 700, height: 450 })).toEqual({
      left: 20,
      top: 30,
      width: 700,
      height: 450,
    });
  });

  it("remembers a maximised window by where it restores to, not the desk it covered", () => {
    expect(
      memorableRect({
        mode: "max",
        left: 0,
        top: 0,
        width: 1024,
        height: 700,
        restore: { left: 20, top: 30, width: 700, height: 450 },
      }),
    ).toEqual({ left: 20, top: 30, width: 700, height: 450 });
  });

  it("answers nothing for a minimised window, whose geometry is not on screen", () => {
    expect(memorableRect({ mode: "min", left: 20, top: 30, width: 700, height: 450 })).toBeUndefined();
  });
});
