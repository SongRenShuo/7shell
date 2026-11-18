/**
 * The widget set's own rules: what a session's first visit gets, what a stored record means, and
 * what junk a reader refuses rather than draws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { usageTone, WORKBENCH_WIDGET_IDS, readDesktopWidgets, writeDesktopWidgets } from "./desktopWidgets";

const SESSION = "session-1";
const KEY = "sevenshell-workbench-widgets:session-1";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("readDesktopWidgets", () => {
  it("offers every widget on a first visit", () => {
    expect([...readDesktopWidgets(SESSION)]).toEqual([...WORKBENCH_WIDGET_IDS]);
  });

  it("answers exactly the stored set, in the widget order", () => {
    localStorage.setItem(KEY, JSON.stringify(["storage", "system"]));
    expect([...readDesktopWidgets(SESSION)]).toEqual(["system", "storage"]);
  });

  it("refuses unknown ids and junk shapes instead of drawing from them", () => {
    localStorage.setItem(KEY, JSON.stringify(["storage", "printer", 7]));
    expect([...readDesktopWidgets(SESSION)]).toEqual(["storage"]);
    localStorage.setItem(KEY, "not json");
    expect([...readDesktopWidgets(SESSION)]).toEqual([...WORKBENCH_WIDGET_IDS]);
    localStorage.setItem(KEY, JSON.stringify("nope"));
    expect([...readDesktopWidgets(SESSION)]).toEqual([...WORKBENCH_WIDGET_IDS]);
  });
});

describe("writeDesktopWidgets", () => {
  it("round-trips a set", () => {
    writeDesktopWidgets(SESSION, new Set(["cpu", "net"]));
    expect(readDesktopWidgets(SESSION)).toEqual(new Set(["cpu", "net"]));
  });
});

describe("usageTone", () => {
  it("wears amber only in the 90-95 band and red past 95", () => {
    expect(usageTone(89)).toBe("ok");
    expect(usageTone(90)).toBe("warn");
    expect(usageTone(95)).toBe("danger");
    expect(usageTone(97)).toBe("danger");
  });
});
