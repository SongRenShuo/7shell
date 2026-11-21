/**
 * The log search's readings, as the view uses them: a literal that finds what it says, a pattern
 * the engine refuses that comes back as an error instead of a throw, a count that keeps its
 * balance against a greedy or zero-width pattern, and segments a highlighter can draw.
 */
import { describe, expect, it } from "vitest";

import { compileLogQuery, findLogMatches, LOG_MATCH_CAP, logSegments } from "@/components/container/logSearch";

describe("compileLogQuery", () => {
  it("reads an empty query as no search, not as an error", () => {
    expect(compileLogQuery("", "literal")).toEqual({ ok: true, pattern: null });
    expect(compileLogQuery("", "regex")).toEqual({ ok: true, pattern: null });
  });

  it("matches a literal query case-blind and anywhere, the way a log is scanned", () => {
    const compiled = compileLogQuery("Error connecting", "literal");
    if (!compiled.ok) {
      throw new Error("a literal query always compiles");
    }
    expect(compiled.pattern).not.toBeNull();
    expect(compiled.pattern?.test("2026-11-10T10:00:00Z error connecting to upstream")).toBe(true);
    expect(compiled.pattern?.test("all is well")).toBe(false);
  });

  it("takes a literal's brackets as characters to find, not grammar to read", () => {
    const compiled = compileLogQuery("[err]", "literal");
    if (!compiled.ok) {
      throw new Error("a literal query always compiles");
    }
    expect(compiled.pattern?.test("value [err] at row 3")).toBe(true);
    expect(compiled.pattern?.test("value err at row 3"), "the class is not read as one").toBe(false);
  });

  it("reads a regex query as the engine reads one", () => {
    const compiled = compileLogQuery("connect(ed|ing)", "regex");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    expect(compiled.pattern?.test("it connected at once")).toBe(true);
    expect(compiled.pattern?.test("connection established"), "the stem alone is not the alternation").toBe(false);
  });

  it("hands back an error for a pattern the engine refuses, instead of throwing", () => {
    const compiled = compileLogQuery("unclosed(", "regex");
    expect(compiled.ok).toBe(false);
    if (!compiled.ok) {
      expect(compiled.error).not.toBe("");
    }
    expect(() => compileLogQuery("unclosed(", "regex")).not.toThrow();
  });
});

describe("findLogMatches", () => {
  const lines = ["started", "connection refused", "reconnected", "nothing here"];

  it("finds every occurrence in reading order, with the line it sits on", () => {
    const compiled = compileLogQuery("nect", "literal");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    expect(findLogMatches(lines, compiled.pattern)).toEqual([
      { line: 1, start: 3, end: 7 },
      { line: 2, start: 5, end: 9 },
    ]);
  });

  it("finds two hits on one line as two matches", () => {
    const compiled = compileLogQuery("ed", "literal");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    expect(findLogMatches(["seeded"], compiled.pattern)).toEqual([
      { line: 0, start: 2, end: 4 },
      { line: 0, start: 4, end: 6 },
    ]);
  });

  it("counts nothing for a pattern that misses", () => {
    const compiled = compileLogQuery("timeout", "literal");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    expect(findLogMatches(lines, compiled.pattern)).toEqual([]);
  });

  it("survives a zero-width pattern without looping forever", () => {
    const compiled = compileLogQuery("a*", "regex");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    const matches = findLogMatches(["bbb", "banana"], compiled.pattern);
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.length).toBeLessThanOrEqual(LOG_MATCH_CAP);
  });

  it("stops at the cap instead of enumerating a buffer's worth of nothing", () => {
    const compiled = compileLogQuery("x*", "regex");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    const matches = findLogMatches(["y".repeat(100)], compiled.pattern);
    expect(matches.length).toBeLessThanOrEqual(LOG_MATCH_CAP);
  });
});

describe("logSegments", () => {
  it("hands a line back whole when there is no pattern", () => {
    expect(logSegments("started", null)).toEqual([{ text: "started", hit: false }]);
  });

  it("cuts the hits out so a highlighter can draw them", () => {
    const compiled = compileLogQuery("err", "literal");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    expect(logSegments("no error here", compiled.pattern)).toEqual([
      { text: "no ", hit: false },
      { text: "err", hit: true },
      { text: "or here", hit: false },
    ]);
  });

  it("glues two hits on one line into two marked pieces", () => {
    const compiled = compileLogQuery("an", "literal");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    const segments = logSegments("banana", compiled.pattern);
    expect(segments.filter((segment) => segment.hit)).toHaveLength(2);
    expect(segments.map((segment) => segment.text).join("")).toBe("banana");
  });

  it("rebuilds the line exactly, hit or miss", () => {
    const compiled = compileLogQuery("(re)?conn(a)?ct", "regex");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    const text = "reconnect connection";
    const segments = logSegments(text, compiled.pattern);
    expect(segments.map((segment) => segment.text).join("")).toBe(text);
  });

  it("survives a zero-width pattern with an empty line", () => {
    const compiled = compileLogQuery("a*", "regex");
    if (!compiled.ok) {
      throw new Error("the pattern compiles");
    }
    expect(() => logSegments("", compiled.pattern)).not.toThrow();
    const segments = logSegments("bbb", compiled.pattern);
    expect(segments.map((segment) => segment.text).join("")).toBe("bbb");
  });
});
