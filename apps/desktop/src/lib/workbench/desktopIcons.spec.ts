/**
 * The desktop shortcuts' own rules: what may become one, what the list does about it, and what a
 * map written by an earlier run still means.
 *
 * The pane's suite says what opening a shortcut does; what can only be seen here is the list's own
 * arithmetic — the cap that drops the oldest, the duplicate that adds nothing, and the junk a later
 * reader refuses rather than draws.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MAX_DESKTOP_SHORTCUTS,
  addShortcut,
  isValidShortcutPath,
  parseDesktopShortcuts,
  readDesktopShortcuts,
  removeShortcut,
  shortcutName,
  writeDesktopShortcuts,
  WORKBENCH_DESKTOP_SHORTCUTS_KEY,
  type DesktopShortcut,
} from "./desktopIcons";

const id = (n: number): string => `shortcut-${n}`;

const entry = (n: number, path?: string): DesktopShortcut => ({ id: id(n), path: path ?? `/srv/${n}` });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("isValidShortcutPath", () => {
  it("accepts an ordinary absolute path", () => {
    expect(isValidShortcutPath("/home/user/projects")).toBe(true);
  });

  it("accepts a path that only needs its edges trimmed", () => {
    expect(isValidShortcutPath("  /var/log  ")).toBe(true);
  });

  it("refuses the empty answer, in every shape of empty", () => {
    expect(isValidShortcutPath("")).toBe(false);
    expect(isValidShortcutPath("   ")).toBe(false);
  });

  it("refuses a path carrying a control character", () => {
    expect(isValidShortcutPath("/tmp/a\nb")).toBe(false);
    expect(isValidShortcutPath("/tmp/a\tb")).toBe(false);
    expect(isValidShortcutPath("/tmp/a\u0000b")).toBe(false);
    expect(isValidShortcutPath("/tmp/a\u007fb")).toBe(false);
  });
});

describe("addShortcut", () => {
  it("appends a new shortcut at the end, which is the order the icons are drawn in", () => {
    const list = addShortcut([entry(1)], "/var/log", "next");
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({ id: "next", path: "/var/log" });
  });

  it("adds nothing for a path that is not a path, and hands back the same order", () => {
    const list = [entry(1), entry(2)];
    expect(addShortcut(list, "", "next")).toEqual(list);
    expect(addShortcut(list, "  ", "next")).toEqual(list);
    expect(addShortcut(list, "/tmp/a\nb", "next")).toEqual(list);
  });

  it("adds nothing for a path already on the desktop, instead of stacking a second icon", () => {
    const list = [entry(1), entry(2, "/var/log")];
    expect(addShortcut(list, "/var/log", "next")).toEqual(list);
  });

  it("keeps the newest when the desktop is full, dropping the oldest to make room", () => {
    const full = Array.from({ length: MAX_DESKTOP_SHORTCUTS }, (_, n) => entry(n));
    const list = addShortcut(full, "/var/log", "next");
    expect(list).toHaveLength(MAX_DESKTOP_SHORTCUTS);
    expect(
      list.some((shortcut) => shortcut.id === id(0)),
      "the oldest is gone",
    ).toBe(false);
    expect(list.at(-1)).toEqual({ id: "next", path: "/var/log" });
  });
});

describe("removeShortcut", () => {
  it("takes out exactly the shortcut of this id", () => {
    const list = [entry(1), entry(2), entry(3)];
    expect(removeShortcut(list, id(2))).toEqual([entry(1), entry(3)]);
  });

  it("changes nothing when the id names no shortcut", () => {
    const list = [entry(1)];
    expect(removeShortcut(list, "missing")).toEqual(list);
  });
});

describe("shortcutName", () => {
  it("is the path's own last segment", () => {
    expect(shortcutName("/home/user/projects")).toBe("projects");
    expect(shortcutName("/")).toBe("/");
  });

  it("ignores trailing slashes, which a typed path often carries", () => {
    expect(shortcutName("/srv/logs/")).toBe("logs");
  });
});

describe("the stored map", () => {
  it("round-trips through the WebView's own storage, keyed by session", () => {
    writeDesktopShortcuts({ "session-1": [entry(1), entry(2)] });
    expect(readDesktopShortcuts()).toEqual({ "session-1": [entry(1), entry(2)] });
  });

  it("reads nothing when nothing was written", () => {
    expect(readDesktopShortcuts()).toEqual({});
  });

  it("reads junk as an empty desktop rather than a broken one", () => {
    localStorage.setItem(WORKBENCH_DESKTOP_SHORTCUTS_KEY, "not json at all");
    expect(readDesktopShortcuts()).toEqual({});

    localStorage.setItem(WORKBENCH_DESKTOP_SHORTCUTS_KEY, "42");
    expect(readDesktopShortcuts()).toEqual({});

    localStorage.setItem(WORKBENCH_DESKTOP_SHORTCUTS_KEY, "[1,2]");
    expect(readDesktopShortcuts()).toEqual({});
  });

  it("drops entries that are not shortcuts, and repeats of one already kept", () => {
    const raw = JSON.stringify({
      "session-1": [entry(1), { id: "", path: "/srv" }, { id: "x", path: "" }, entry(1)],
    });
    expect(parseDesktopShortcuts(raw)).toEqual({ "session-1": [entry(1)] });
  });

  it("skips a session key that is empty or holds something other than a list", () => {
    const raw = JSON.stringify({ "": [entry(1)], "session-1": "no" });
    expect(parseDesktopShortcuts(raw)).toEqual({});
  });

  it("keeps a session out of the map when none of its shortcuts survived", () => {
    const raw = JSON.stringify({ "session-1": [{ id: "", path: "/srv" }] });
    expect(parseDesktopShortcuts(raw)).toEqual({});
  });

  it("honours the cap on whatever was read, not only on what was added", () => {
    const full = Array.from({ length: MAX_DESKTOP_SHORTCUTS + 5 }, (_, n) => entry(n));
    const raw = JSON.stringify({ "session-1": full });
    const read = parseDesktopShortcuts(raw)["session-1"] ?? [];
    expect(read).toHaveLength(MAX_DESKTOP_SHORTCUTS);
    expect(read[0]?.id).toBe(id(0));
  });
});
