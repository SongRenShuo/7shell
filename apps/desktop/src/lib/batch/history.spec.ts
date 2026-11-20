/**
 * The batch history's rules: what a run records, what a repeat collapses, and what a store
 * holding something unreadable reads as.
 *
 * The panel wiring — the arrows, the popover — is the component's; here are the rules themselves.
 */
import { beforeEach, describe, expect, it } from "vitest";

import { clearHistory, loadHistory, pushHistory, BATCH_HISTORY_LIMIT } from "@/lib/batch/history";

beforeEach(() => {
  window.localStorage.clear();
});

describe("the batch history", () => {
  it("starts empty", () => {
    expect(loadHistory()).toEqual([]);
  });

  it("records a run at the front, trimmed", () => {
    pushHistory("  uptime  ");

    expect(loadHistory()).toEqual(["uptime"]);
  });

  it("answers nothing for a blank command", () => {
    pushHistory("   ");

    expect(loadHistory()).toEqual([]);
  });

  it("collapses a repeat of the newest entry instead of stacking it", () => {
    pushHistory("uptime");
    pushHistory("free -m");
    pushHistory("uptime");

    expect(loadHistory()).toEqual(["uptime", "free -m"]);
  });

  it("lets the tail fall off past the limit", () => {
    for (let index = 0; index < BATCH_HISTORY_LIMIT + 4; index += 1) {
      pushHistory(`command-${index}`);
    }

    const list = loadHistory();
    expect(list).toHaveLength(BATCH_HISTORY_LIMIT);
    expect(list[0]).toBe(`command-${BATCH_HISTORY_LIMIT + 3}`);
    expect(list).not.toContain("command-0");
  });

  it("clears everything and reads empty afterwards", () => {
    pushHistory("uptime");
    clearHistory();

    expect(loadHistory()).toEqual([]);
  });

  it("reads a store holding junk as empty rather than throwing", () => {
    window.localStorage.setItem("batch:history", "not json at all");

    expect(loadHistory()).toEqual([]);
  });
});
