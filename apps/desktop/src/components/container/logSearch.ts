/**
 * The log search's readings, in one place so the spec can question them.
 *
 * Search never touches the stream: it reads the buffer the view already holds, so the lines that
 * keep arriving while somebody searches are matched the moment they land — the highlights are
 * recomputed from the same buffer, and appending costs the stream nothing. A query that reads as a
 * literal is matched the way a person scans a log (case-blind, anywhere in the line); a query read
 * as a regular expression is matched as the engine's own RegExp reads it, and one the engine
 * refuses comes back as an error for the view to say inline rather than a throw for nobody.
 */

/** The two ways a query can be read. */
export type LogQueryMode = "literal" | "regex";

/** A query the view can draw with: a pattern to match, or the reason it cannot. */
export type CompiledLogQuery =
  | { readonly ok: true; readonly pattern: RegExp | null }
  | { readonly ok: false; readonly error: string };

/**
 * Escapes the characters a RegExp would read as grammar, so a literal query matches itself.
 *
 * A bracket a person typed is a bracket they expect to find, not the opening of a class.
 */
function escapeLiteral(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reads a query in the mode it was typed in.
 *
 * Both modes match case-blind and anywhere in the line, the way a person scanning a log searches —
 * `error` should find the line that says `Error connecting`. An empty query compiles to no pattern:
 * it is not an error, it is no search at all.
 */
export function compileLogQuery(query: string, mode: LogQueryMode): CompiledLogQuery {
  if (query === "") {
    return { ok: true, pattern: null };
  }
  const source = mode === "regex" ? query : escapeLiteral(query);
  try {
    return { ok: true, pattern: new RegExp(source, "i") };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * How many hits one view is willing to enumerate for counting and jumping.
 *
 * A query like `a*` matches between every pair of letters: without a cap the occurrence list
 * becomes the buffer's own size squared. The cap bounds the list, not the honesty of the count —
 * a search that outruns it says the number it stopped at rather than a number it never reached.
 */
export const LOG_MATCH_CAP = 5_000;

/** One match, as the jump navigation needs it: which line, and where in its text. */
export interface LogMatch {
  /** The line's position in the list the search ran over. */
  readonly line: number;
  /** Where the match opens and closes in that line's text. */
  readonly start: number;
  readonly end: number;
}

/** Every match the pattern finds in the texts, in reading order, capped at `LOG_MATCH_CAP`. */
export function findLogMatches(texts: readonly string[], pattern: RegExp | null): LogMatch[] {
  if (pattern === null) {
    return [];
  }
  const matches: LogMatch[] = [];
  for (let index = 0; index < texts.length && matches.length < LOG_MATCH_CAP; index += 1) {
    const text = texts[index] ?? "";
    const scanner = globalScanner(pattern);
    let guard = 0;
    let at = scanner.exec(text);
    while (at !== null && matches.length < LOG_MATCH_CAP && guard < LOG_MATCH_CAP) {
      const length = at[0]?.length ?? 0;
      matches.push({ line: index, start: at.index, end: at.index + length });
      // A zero-width match (`a*`) would leave the scanner where it stands and loop forever.
      if (scanner.lastIndex === at.index) {
        scanner.lastIndex = at.index + 1;
      }
      at = scanner.exec(text);
      guard += 1;
    }
  }
  return matches;
}

/**
 * A copy of the pattern with the global flag, so scanning never moves a pattern the view shares.
 *
 * `RegExp` keeps `lastIndex` between calls; one pattern reused across lines and renders would
 * otherwise start each search where the last one stopped.
 */
function globalScanner(pattern: RegExp): RegExp {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return new RegExp(pattern.source, flags);
}

/** One piece of a line's text, for the highlighter to draw: the text itself, and whether it hit. */
export interface LogSegment {
  readonly text: string;
  readonly hit: boolean;
}

/** Splits one line's text into hit and miss segments. With no pattern, the line is one miss. */
export function logSegments(text: string, pattern: RegExp | null): LogSegment[] {
  if (pattern === null || text === "") {
    return [{ text, hit: false }];
  }
  const segments: LogSegment[] = [];
  const scanner = globalScanner(pattern);
  let drawn = 0;
  let guard = 0;
  let found = scanner.exec(text);
  while (found !== null && guard < LOG_MATCH_CAP) {
    const length = found[0]?.length ?? 0;
    if (found.index > drawn) {
      segments.push({ text: text.slice(drawn, found.index), hit: false });
    }
    if (length > 0) {
      segments.push({ text: text.slice(found.index, found.index + length), hit: true });
    }
    // The pen moves past every match, even the empty ones a zero-width pattern finds — otherwise
    // the next slice would begin where the last one began, and the line would come back doubled.
    drawn = found.index + length;
    if (scanner.lastIndex === found.index) {
      scanner.lastIndex = found.index + 1;
    }
    found = scanner.exec(text);
    guard += 1;
  }
  if (drawn < text.length) {
    segments.push({ text: text.slice(drawn), hit: false });
  }
  return segments;
}
