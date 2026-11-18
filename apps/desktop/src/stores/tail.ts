/**
 * One followed file per window: what the log-tracking window is reading, and the lines that are
 * still arriving.
 *
 * The same four rules the container store is shaped by apply here, because the stream is the same
 * kind of thing — a far-side producer a window watches, riding one pair of backend events keyed by
 * id:
 *
 * 1. **A window owns its tail, by id.** The store is keyed by the desktop window's own id, so two
 *    tail windows on one session do not write into each other.
 * 2. **Lines are routed, never broadcast.** One subscription for the whole store; each arriving
 *    line is looked up by its tail id and handed to the one window that opened it. A line for a
 *    tail nobody here opened reaches nothing — which is the filter the spec asks for by another
 *    name: events for other windows' ids are ignored, not appended.
 * 3. **Pause keeps, resume re-reads.** A pause closes the stream but keeps every line already read
 *    and the path they came from, because the point of pausing is to stop the flow, not to forget
 *    it. A resume opens the same path again, which means the far side sends its initial tail once
 *    more — so the buffer starts over rather than showing a seam of duplicated lines, and the
 *    window says so: lines written while the stream was paused are gone until the fresh tail
 *    brings back what the file still holds.
 * 4. **The buffer is bounded.** A file that grows faster than somebody reads it must not grow this
 *    store with it; the oldest lines fall off the top at the cap, the same deal the container log
 *    view makes.
 */
import { defineStore } from "pinia";
import { ref } from "vue";

import { backend } from "@/lib/backend/api";
import { type ShellError, asShellError } from "@/lib/backend/errors";
import { listen } from "@/lib/backend/ipc";
import { isValidShortcutPath } from "@/lib/workbench/desktopIcons";

/**
 * The two events the far side writes lines through, keyed by tail id.
 *
 * The names are the batch-six contract (`tail_line { tailId, line }`, `tail_end { tailId, error? }`);
 * if the core lands them under other names the reconciliation happens here, at the only two
 * constants that know them.
 */
export const TAIL_LINE_EVENT = "tail_line";
export const TAIL_END_EVENT = "tail_end";

/** What a `tail_line` event carries. */
export interface TailLineEvent {
  readonly tailId: string;
  readonly line: string;
}

/** What a `tail_end` event carries. The error is the backend's own sentence, when it ended badly. */
export interface TailEndEvent {
  readonly tailId: string;
  readonly error?: string;
}

/** How many lines one followed file keeps in memory; older ones fall off the top. */
export const TAIL_LINE_LIMIT = 1000;

/** The initial tail a stream is opened with when nobody chose a size. */
export const DEFAULT_TAIL_LINES = 200;

/** The sizes the log-tracking window offers. The far side clamps, so these are suggestions. */
export const TAIL_OPEN_SIZES = [200, 500, 1000] as const;

export type TailStatus = "idle" | "connecting" | "following" | "paused" | "ended";

/** Everything one window knows about the file it is following. */
export interface TailState {
  /** The stream the far side is writing, or `null` while none is open (idle, paused, ended). */
  tailId: string | null;
  /** The file being followed, kept through a pause so a resume can ask for it again. */
  path: string;
  /** The lines shown, oldest first. Bounded at {@link TAIL_LINE_LIMIT}. */
  lines: string[];
  /** Why the stream ended, when it ended badly; the backend's own sentence. */
  error: string | null;
  /** The open's refusal, kept so the window can render the envelope sentence where the person is. */
  failure: ShellError | null;
  status: TailStatus;
  /** The initial tail this file was opened with; a resume asks for the same again. */
  requested: number;
  /** The session the stream rides on; kept so a resume needs nothing but the window's own state. */
  sessionId: string;
}

// -- pure helpers ------------------------------------------------------------

/**
 * Whether a typed path may be followed.
 *
 * The far side is a Linux machine, so a relative path would be resolved against whatever directory
 * the shell lands in — a file somebody did not mean. The control-character rule is the desktop
 * shortcut's own, reused rather than re-decided: a control character would ride into the shell
 * command the far side builds invisibly.
 */
export function isValidTailPath(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  return isValidShortcutPath(trimmed);
}

/** Appends a line to a bounded buffer, dropping the oldest once it is full. */
export function appendTailLine(buffer: string[], line: string, limit = TAIL_LINE_LIMIT): void {
  buffer.push(line);
  if (buffer.length > limit) {
    buffer.splice(0, buffer.length - limit);
  }
}

// -- the store ---------------------------------------------------------------

export const useTailStore = defineStore("tail", () => {
  /** The live tails, by desktop window id. */
  const tails = ref<Record<string, TailState>>({});

  /**
   * Routing for the two stream events: which window opened which tail. Empty means the id is
   * nobody's business here — a line for it reaches nothing rather than a window that never asked.
   */
  const routes = new Map<string, string>();

  let listening = false;
  let unlisten: (() => void)[] = [];
  let subscription: Promise<void> | null = null;
  let subscriptionToken = 0;

  /** The state a window draws, made on first ask so the window never reads a missing entry. */
  function ensure(windowId: string): TailState {
    const existing = tails.value[windowId];
    if (existing) {
      return existing;
    }
    tails.value[windowId] = {
      tailId: null,
      path: "",
      lines: [],
      error: null,
      failure: null,
      status: "idle",
      requested: DEFAULT_TAIL_LINES,
      sessionId: "",
    };
    return tails.value[windowId] as TailState;
  }

  function tailOf(windowId: string): TailState | undefined {
    return tails.value[windowId];
  }

  /** Whether the window's stream is live right now — the window's Follow/Pause button reads this. */
  function isFollowing(windowId: string): boolean {
    return tails.value[windowId]?.status === "following";
  }

  /**
   * Reads the two stream events once for the whole store.
   *
   * One subscription rather than one per window, for the same reason the container store gives: the
   * events are keyed by tail id, and a second listener would deliver every line twice to whichever
   * two windows happened to be open.
   */
  function listenOnce(): Promise<void> {
    if (subscription) {
      return subscription;
    }
    listening = true;
    // A token rather than a boolean: a release that happens while the listeners are being made has
    // to be recognisable when they arrive, or a second start would have its listeners overwritten
    // by the first one's.
    const token = ++subscriptionToken;
    subscription = Promise.all([
      listen<TailLineEvent>(TAIL_LINE_EVENT, (event) => {
        const windowId = routes.get(event.payload.tailId);
        if (windowId === undefined) {
          // Not a tail this store opened: another window's line, or one already stopped. Dropped.
          return;
        }
        const state = tails.value[windowId];
        if (state?.tailId === event.payload.tailId) {
          appendTailLine(state.lines, event.payload.line);
        }
      }),
      listen<TailEndEvent>(TAIL_END_EVENT, (event) => {
        const windowId = routes.get(event.payload.tailId);
        if (windowId === undefined) {
          return;
        }
        const state = tails.value[windowId];
        if (state?.tailId !== event.payload.tailId) {
          return;
        }
        // The route is gone before the window hears about it, so a second end finds nothing.
        routes.delete(event.payload.tailId);
        state.tailId = null;
        state.error = event.payload.error ?? null;
        state.status = "ended";
      }),
    ])
      .then((stops) => {
        if (!listening || token !== subscriptionToken) {
          for (const stop of stops) {
            stop();
          }
          return;
        }
        unlisten = stops;
      })
      .catch((error: unknown) => {
        if (token === subscriptionToken) {
          listening = false;
          subscription = null;
        }
        throw error;
      });
    return subscription;
  }

  /** Lets the events go once no window holds a tail any more. */
  function maybeRelease(): void {
    if (Object.keys(tails.value).length > 0 || routes.size > 0) {
      return;
    }
    listening = false;
    subscriptionToken += 1;
    for (const stop of unlisten) {
      stop();
    }
    unlisten = [];
    subscription = null;
  }

  /** Forgets a stream's routing without asking the backend, which is about to be told anyway. */
  function unroute(tailId: string | null): void {
    if (tailId !== null) {
      routes.delete(tailId);
    }
  }

  async function closeQuietly(tailId: string | null): Promise<void> {
    unroute(tailId);
    if (tailId === null) {
      return;
    }
    try {
      await backend.tails.close(tailId);
    } catch {
      // It is already gone from this side; a backend that forgot it has nothing to report.
    }
  }

  /**
   * Follows a file: opens the stream and routes its lines into this window's buffer.
   *
   * Safe to call on a window that is already following — the old stream is closed first — because
   * the window's own controls and the minimisation rule both arrive here, and neither tracks what
   * the other did.
   */
  async function follow(
    windowId: string,
    sessionId: string,
    path: string,
    requested = DEFAULT_TAIL_LINES,
  ): Promise<void> {
    const previous = tails.value[windowId];
    await closeQuietly(previous?.tailId ?? null);

    tails.value[windowId] = {
      tailId: null,
      path,
      lines: [],
      error: null,
      failure: null,
      status: "connecting",
      requested,
      sessionId,
    };
    // Read back, not kept: a ref's record hands out a reactive stand-in for what was stored, and
    // the guard below compares identity against that stand-in rather than the raw object.
    const fresh = tails.value[windowId] as TailState;

    await listenOnce();
    let tailId: string;
    try {
      tailId = await backend.tails.open(sessionId, path, requested);
    } catch (error) {
      if (tails.value[windowId] === fresh) {
        fresh.failure = asShellError(error, "tail_open");
        fresh.status = "ended";
      }
      return;
    }
    if (tails.value[windowId] !== fresh) {
      // The window was stopped or re-followed while the open was on its way: the answer is a
      // stream nobody here will read, so it is closed rather than left running.
      await closeQuietly(tailId);
      return;
    }
    fresh.tailId = tailId;
    routes.set(tailId, windowId);
    fresh.status = "following";
  }

  /**
   * Pauses a window's stream: the far side stops writing, everything already read stays.
   *
   * `-F` is the far side's business, so what was written while nobody was reading is missed — the
   * window says so rather than implying the pause was free. A resume re-reads the file's own tail,
   * which recovers what the file still holds.
   */
  async function pause(windowId: string): Promise<void> {
    const state = tails.value[windowId];
    if (!state || (state.status !== "following" && state.status !== "connecting")) {
      return;
    }
    const tailId = state.tailId;
    state.tailId = null;
    state.status = "paused";
    await closeQuietly(tailId);
  }

  /**
   * Resumes a paused window: opens the same path again, on the same session, at the same size.
   *
   * The buffer starts over, because the far side's open answers with its initial tail — keeping the
   * old lines would show every one of them twice. What was written while the stream was paused and
   * has since rotated away is gone for good; that is the price of a pause, and the copy that names
   * it lives in the window.
   */
  async function resume(windowId: string): Promise<void> {
    const state = tails.value[windowId];
    if (!state || state.sessionId === "" || state.path === "") {
      return;
    }
    await follow(windowId, state.sessionId, state.path, state.requested);
  }

  /**
   * Stops a window for good: the stream is closed and the window's state is forgotten.
   *
   * This is what the window calls when it goes away — a closed window leaves nothing behind, which
   * is the long-stream rule the plan writes down for this feature.
   */
  async function stop(windowId: string): Promise<void> {
    const state = tails.value[windowId];
    if (!state) {
      return;
    }
    await closeQuietly(state.tailId);
    delete tails.value[windowId];
    maybeRelease();
  }

  return {
    tails,
    ensure,
    tailOf,
    isFollowing,
    follow,
    pause,
    resume,
    stop,
  };
});
