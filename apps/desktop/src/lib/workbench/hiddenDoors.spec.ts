/**
 * The hidden doors' own rules: what a stored value still means, what happens to an id this build
 * cannot hide, and what the choice costs when the WebView's storage refuses it.
 *
 * The pane's suite says what hiding looks like from the desktop; what can only be seen here is the
 * arithmetic under it — the list the settings dialog writes, the junk a later reader refuses
 * rather than half applies, and the id a build that never drew that door drops on the floor.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  clearHiddenDoors,
  hiddenDoorsKey,
  normalizeHiddenDoors,
  parseHiddenDoors,
  readHiddenDoors,
  WORKBENCH_HIDEABLE_DOOR_IDS,
  writeHiddenDoors,
} from "./hiddenDoors";

const ids = ["system-terminal", "system-docker", "system-trash"] as const;

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("parseHiddenDoors", () => {
  it("reads back the list it wrote", () => {
    expect(parseHiddenDoors(JSON.stringify(["system-docker", "system-tail"]))).toEqual([
      "system-docker",
      "system-tail",
    ]);
  });

  it("reads nothing when nothing was written", () => {
    expect(parseHiddenDoors(null)).toBeNull();
    expect(parseHiddenDoors("")).toBeNull();
  });

  it("reads junk as no choice rather than a broken one", () => {
    expect(parseHiddenDoors("not json at all")).toBeNull();
    expect(parseHiddenDoors("42")).toBeNull();
    expect(parseHiddenDoors('{"hidden":["a"]}')).toBeNull();
    expect(parseHiddenDoors('"system-docker"')).toBeNull();
  });

  it("drops entries that are not ids, and repeats of one already kept", () => {
    expect(parseHiddenDoors(JSON.stringify(["a", 7, "", "a", null, "b"]))).toEqual(["a", "b"]);
  });
});

describe("normalizeHiddenDoors", () => {
  it("is the empty set when nothing was hidden", () => {
    expect(normalizeHiddenDoors(null, ids)).toEqual([]);
    expect(normalizeHiddenDoors([], ids)).toEqual([]);
  });

  it("keeps the ids the build can hide", () => {
    expect(normalizeHiddenDoors(["system-docker"], ids)).toEqual(["system-docker"]);
  });

  it("drops an id the build cannot hide, which is what keeps the choice restorable", () => {
    expect(normalizeHiddenDoors(["system-gone", "system-docker"], ids)).toEqual(["system-docker"]);
  });

  it("drops ids it is handed twice", () => {
    expect(normalizeHiddenDoors(["system-docker", "system-docker"], ids)).toEqual(["system-docker"]);
  });

  it("subtracts against the build's own hideable doors when no list is given", () => {
    expect(normalizeHiddenDoors([...WORKBENCH_HIDEABLE_DOOR_IDS])).toEqual([...WORKBENCH_HIDEABLE_DOOR_IDS]);
    expect(normalizeHiddenDoors(["system-home", "system-trash"])).toEqual([]);
  });
});

describe("the stored choice", () => {
  it("round-trips through the WebView's own storage, keyed by session", () => {
    writeHiddenDoors("session-1", ["system-docker"]);
    expect(readHiddenDoors("session-1")).toEqual(["system-docker"]);
    expect(localStorage.getItem(hiddenDoorsKey("session-1"))).toBe('["system-docker"]');
  });

  it("is nobody's choice until it is written", () => {
    expect(readHiddenDoors("session-1")).toEqual([]);
  });

  it("reads a choice per session, not one for all of them", () => {
    writeHiddenDoors("session-1", ["system-docker"]);
    expect(readHiddenDoors("session-2")).toEqual([]);
  });

  it("applies the choice to a narrower list of doors than the build ships", () => {
    writeHiddenDoors("session-1", ["system-docker", "system-gone"]);
    expect(readHiddenDoors("session-1", ["system-docker", "system-tail"])).toEqual(["system-docker"]);
  });

  it("falls back to every door visible when the stored value is unreadable", () => {
    localStorage.setItem(hiddenDoorsKey("session-1"), "not json at all");
    expect(readHiddenDoors("session-1")).toEqual([]);

    localStorage.setItem(hiddenDoorsKey("session-1"), JSON.stringify({ hidden: ["system-docker"] }));
    expect(readHiddenDoors("session-1")).toEqual([]);
  });

  it("is forgotten by clearing it, which is what the desktop's settings put back", () => {
    writeHiddenDoors("session-1", ["system-docker"]);
    clearHiddenDoors("session-1");
    expect(readHiddenDoors("session-1")).toEqual([]);
    expect(localStorage.getItem(hiddenDoorsKey("session-1"))).toBeNull();
  });
});
