/**
 * The desktop arrangement's own rules: what a stored value still means, what happens to ids this
 * build no longer draws, and where one icon goes when it is dropped onto another.
 *
 * The pane's suite says what a drag looks like from outside; what can only be seen here is the
 * arithmetic under it — the slot the dragged icon takes, the id that stops being found, and the
 * junk a later reader refuses rather than half applies.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearIconOrder,
  iconOrderKey,
  moveIcon,
  normalizeIconOrder,
  parseIconOrder,
  readIconOrder,
  writeIconOrder,
} from "./iconOrder";

const ids = ["system-home", "system-terminal", "system-trash"] as const;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("parseIconOrder", () => {
  it("reads back the list it wrote", () => {
    expect(parseIconOrder(JSON.stringify(["a", "b"]))).toEqual(["a", "b"]);
  });

  it("reads nothing when nothing was written", () => {
    expect(parseIconOrder(null)).toBeNull();
    expect(parseIconOrder("")).toBeNull();
  });

  it("reads junk as no arrangement rather than a broken one", () => {
    expect(parseIconOrder("not json at all")).toBeNull();
    expect(parseIconOrder("42")).toBeNull();
    expect(parseIconOrder('{"order":["a"]}')).toBeNull();
    expect(parseIconOrder('"a"')).toBeNull();
  });

  it("drops entries that are not ids, and repeats of one already kept", () => {
    expect(parseIconOrder(JSON.stringify(["a", 7, "", "a", null, "b"]))).toEqual(["a", "b"]);
  });
});

describe("normalizeIconOrder", () => {
  it("is the default order when nothing was arranged", () => {
    expect(normalizeIconOrder(null, ids)).toEqual([...ids]);
    expect(normalizeIconOrder([], ids)).toEqual([...ids]);
  });

  it("keeps the stored order for icons that are still there", () => {
    expect(normalizeIconOrder(["system-trash", "system-home"], ids)).toEqual([
      "system-trash",
      "system-home",
      "system-terminal",
    ]);
  });

  it("drops an id whose icon is gone", () => {
    expect(normalizeIconOrder(["shortcut:gone", "system-terminal"], ids)).toEqual([
      "system-terminal",
      "system-home",
      "system-trash",
    ]);
  });

  it("appends an icon the arrangement never heard of, without moving anybody else", () => {
    expect(normalizeIconOrder(["system-trash", "system-home"], [...ids, "shortcut:new"])).toEqual([
      "system-trash",
      "system-home",
      "system-terminal",
      "shortcut:new",
    ]);
  });

  it("drops ids it is handed twice", () => {
    expect(normalizeIconOrder(["system-trash", "system-trash"], ids)).toEqual([
      "system-trash",
      "system-home",
      "system-terminal",
    ]);
  });
});

describe("moveIcon", () => {
  it("gives the dragged icon the target's slot, counting the target's own position", () => {
    expect(moveIcon(["a", "b", "c"], "b", "c")).toEqual(["a", "c", "b"]);
    expect(moveIcon(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
    expect(moveIcon(["a", "b", "c"], "a", "b")).toEqual(["b", "a", "c"]);
  });

  it("moves to the end when the desktop itself is the drop", () => {
    expect(moveIcon(["a", "b", "c"], "a", null)).toEqual(["b", "c", "a"]);
  });

  it("changes nothing when the drag dropped the icon on itself", () => {
    expect(moveIcon(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
  });

  it("changes nothing when either id names no icon", () => {
    expect(moveIcon(["a", "b"], "gone", "b")).toEqual(["a", "b"]);
    expect(moveIcon(["a", "b"], "a", "gone")).toEqual(["a", "b"]);
  });
});

describe("the stored order", () => {
  it("round-trips through the WebView's own storage, keyed by session", () => {
    writeIconOrder("session-1", ["system-trash", "system-home"]);
    expect(readIconOrder("session-1")).toEqual(["system-trash", "system-home"]);
    expect(localStorage.getItem(iconOrderKey("session-1"))).toBe('["system-trash","system-home"]');
  });

  it("is nobody's arrangement until it is written", () => {
    expect(readIconOrder("session-1")).toBeNull();
  });

  it("reads a journal per session, not one arrangement for all of them", () => {
    writeIconOrder("session-1", ["system-trash"]);
    expect(readIconOrder("session-2")).toBeNull();
  });

  it("is forgotten by clearing it, which is what the desktop's reset asks for", () => {
    writeIconOrder("session-1", ["system-trash"]);
    clearIconOrder("session-1");
    expect(readIconOrder("session-1")).toBeNull();
    expect(localStorage.getItem(iconOrderKey("session-1"))).toBeNull();
  });
});
