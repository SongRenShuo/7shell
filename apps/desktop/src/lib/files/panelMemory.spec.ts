/**
 * The panel's per-session memory rules: what the recent list keeps, in what order, and what a
 * session's remembered sort order looks like when it comes back.
 *
 * The FileBrowser wiring is this module's caller; what can only be seen here is the shape of the
 * memory itself — the dedupe, the cap, the session isolation, and a store holding something that
 * is not a list reading as empty rather than throwing.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { clearRecent, loadOrder, loadRecent, pushRecent, RECENT_LIMIT, saveOrder } from "@/lib/files/panelMemory";

const SESSION = "session-1";
const OTHER = "session-2";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the recent list", () => {
  it("starts empty and stays empty for a session that has walked nowhere", () => {
    expect(loadRecent(SESSION)).toEqual([]);
  });

  it("puts the newest directory first and keeps only one copy of it", () => {
    pushRecent(SESSION, "/var/log");
    pushRecent(SESSION, "/home");
    pushRecent(SESSION, "/var/log");

    expect(loadRecent(SESSION)).toEqual(["/var/log", "/home"]);
  });

  it("lets the tail fall off past the limit rather than growing forever", () => {
    for (let index = 0; index < RECENT_LIMIT + 3; index += 1) {
      pushRecent(SESSION, `/dir/${index}`);
    }

    const list = loadRecent(SESSION);
    expect(list).toHaveLength(RECENT_LIMIT);
    expect(list[0]).toBe(`/dir/${RECENT_LIMIT + 2}`);
    expect(loadRecent(SESSION)).not.toContain("/dir/0");
  });

  it("keeps one session's walks out of another session's list", () => {
    pushRecent(SESSION, "/var/log");

    expect(loadRecent(OTHER)).toEqual([]);

    pushRecent(OTHER, "/etc");
    expect(loadRecent(SESSION)).toEqual(["/var/log"]);
  });

  it("clears the whole list and reports empty afterwards", () => {
    pushRecent(SESSION, "/var/log");
    clearRecent(SESSION);

    expect(loadRecent(SESSION)).toEqual([]);
  });
});

describe("the remembered order", () => {
  it("answers null for a session that never pressed a heading", () => {
    expect(loadOrder(SESSION)).toBeNull();
  });

  it("round-trips the column and the end it was read from", () => {
    saveOrder(SESSION, { column: "size", descending: true });

    expect(loadOrder(SESSION)).toEqual({ column: "size", descending: true });
  });

  it("reads a column it does not know as no order at all, not as a crash", () => {
    window.localStorage.setItem("files:order:session-1", JSON.stringify({ column: "mood", descending: true }));

    expect(loadOrder(SESSION)).toBeNull();
  });

  it("reads a store holding junk as no order at all", () => {
    window.localStorage.setItem("files:order:session-1", "{not json");

    expect(loadOrder(SESSION)).toBeNull();
  });
});
