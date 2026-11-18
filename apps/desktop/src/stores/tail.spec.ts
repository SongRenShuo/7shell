/**
 * The tail store: one followed file per window, and the lines that keep arriving.
 *
 * What can only be seen here is the wiring the window depends on — one subscription for every
 * tail, a line routed by its tail id to the one window that opened it (and a line for a tail
 * nobody here opened reaching nothing), a pause that closes the stream but keeps the lines and
 * the path, a resume that opens the same path again, and a buffer that stays bounded when the
 * file grows faster than anybody reads.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));

// The store rides the transport's own event listener, so the spec keeps the handlers and fires
// them itself: the events the far side writes are the input this store is written against.
const lineListeners: ((payload: unknown) => void)[] = [];
const endListeners: ((payload: unknown) => void)[] = [];

vi.mock("@/lib/backend/ipc", () => ({
  listen: vi.fn(async (event: string, handler: (payload: unknown) => void) => {
    if (event === "tail_line") {
      lineListeners.push(handler);
    } else if (event === "tail_end") {
      endListeners.push(handler);
    }
    return () => {};
  }),
}));

vi.mock("@/lib/backend/tauri", () => ({
  fileTailOpen: vi.fn(),
  fileTailClose: vi.fn(async () => {}),
}));

import { fileTailClose, fileTailOpen } from "@/lib/backend/tauri";
import {
  appendTailLine,
  TAIL_LINE_LIMIT,
  TAIL_LINE_EVENT,
  TAIL_END_EVENT,
  useTailStore,
  isValidTailPath,
} from "@/stores/tail";

const openMock = vi.mocked(fileTailOpen);
const closeMock = vi.mocked(fileTailClose);

function emitLine(tailId: string, line: string): void {
  const snapshot = [...lineListeners];
  for (const handler of snapshot) {
    handler({ payload: { tailId, line } });
  }
}

function emitEnd(tailId: string, error?: string): void {
  const snapshot = [...endListeners];
  for (const handler of snapshot) {
    handler({ payload: { tailId, error } });
  }
}

beforeEach(() => {
  setActivePinia(createPinia());
  lineListeners.length = 0;
  endListeners.length = 0;
  openMock.mockReset();
  closeMock.mockClear();
  closeMock.mockResolvedValue(undefined);
});

async function followed(
  store: ReturnType<typeof useTailStore>,
  windowId: string,
  tailId: string,
  path = "/var/log/app.log",
): Promise<void> {
  openMock.mockResolvedValueOnce(tailId);
  await store.follow(windowId, "session-1", path);
}

describe("the tail store", () => {
  it("opens the stream, routes the lines into the window that asked, and counts as following", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");

    expect(openMock).toHaveBeenCalledWith("session-1", "/var/log/app.log", 200);
    expect(store.isFollowing("w1")).toBe(true);
    expect(store.tailOf("w1")?.tailId).toBe("tail-1");

    emitLine("tail-1", "first");
    emitLine("tail-1", "second");
    expect(store.tailOf("w1")?.lines).toEqual(["first", "second"]);
  });

  it("ignores lines for tails this store did not open", () => {
    const store = useTailStore();
    store.ensure("w1");

    emitLine("tail-unknown", "somebody else's line");
    expect(store.tailOf("w1")?.lines).toEqual([]);
  });

  it("a line for one window's tail never lands in another window's buffer", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");
    await followed(store, "w2", "tail-2");

    emitLine("tail-2", "for the second window");
    expect(store.tailOf("w1")?.lines).toEqual([]);
    expect(store.tailOf("w2")?.lines).toEqual(["for the second window"]);
  });

  it("pauses by closing the stream but keeping the lines and the path", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");
    emitLine("tail-1", "kept");

    await store.pause("w1");

    expect(closeMock).toHaveBeenCalledWith("tail-1");
    const state = store.tailOf("w1");
    expect(state?.tailId).toBeNull();
    expect(state?.status).toBe("paused");
    expect(state?.path).toBe("/var/log/app.log");
    expect(state?.lines).toEqual(["kept"]);

    // A stream that has been closed sends nothing more; even if one arrives, it reaches nothing.
    emitLine("tail-1", "late");
    expect(state?.lines).toEqual(["kept"]);
  });

  it("resumes by reopening the same path on the same session, at the same size", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1", "/var/log/syslog");
    await store.pause("w1");

    openMock.mockResolvedValueOnce("tail-2");
    await store.resume("w1");

    expect(openMock).toHaveBeenLastCalledWith("session-1", "/var/log/syslog", 200);
    expect(store.tailOf("w1")?.tailId).toBe("tail-2");
    expect(store.isFollowing("w1")).toBe(true);
  });

  it("a resume starts the buffer over, because the far side sends its initial tail again", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");
    emitLine("tail-1", "old");
    await store.pause("w1");

    openMock.mockResolvedValueOnce("tail-2");
    await store.resume("w1");
    emitLine("tail-2", "fresh");

    expect(store.tailOf("w1")?.lines).toEqual(["fresh"]);
  });

  it("the stream ending on its own is recorded, and the id stops routing", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");

    emitEnd("tail-1", "the file was rotated away");
    const state = store.tailOf("w1");
    expect(state?.tailId).toBeNull();
    expect(state?.status).toBe("ended");
    expect(state?.error).toBe("the file was rotated away");

    emitLine("tail-1", "late");
    expect(state?.lines).toEqual([]);
  });

  it("an open refusal keeps the envelope and the window says so, rather than pretending to follow", async () => {
    const store = useTailStore();
    openMock.mockRejectedValueOnce(new Error("policy said no"));
    await store.follow("w1", "session-1", "/etc/shadow");

    const state = store.tailOf("w1");
    expect(state?.tailId).toBeNull();
    expect(state?.status).toBe("ended");
    expect(state?.failure).not.toBeNull();
    expect(state?.failure?.code).toBe("APP-INTERNAL");
  });

  it("stops a window: the stream is closed and the state is forgotten", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");

    await store.stop("w1");

    expect(closeMock).toHaveBeenCalledWith("tail-1");
    expect(store.tailOf("w1")).toBeUndefined();
    expect(store.isFollowing("w1")).toBe(false);
  });

  it("a window that was stopped while its open was on the way does not leave the stream running", async () => {
    const store = useTailStore();
    let answer: ((value: string) => void) | undefined;
    openMock.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        answer = resolve;
      }),
    );
    const pending = store.follow("w1", "session-1", "/var/log/app.log");
    // Wait until the open is genuinely on its way — stopping before the state exists stops nothing.
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalled();
    });
    await store.stop("w1");
    answer?.("tail-late");
    await pending;

    expect(closeMock).toHaveBeenCalledWith("tail-late");
    expect(store.tailOf("w1")).toBeUndefined();
  });

  it("following again replaces the old stream with the new one", async () => {
    const store = useTailStore();
    await followed(store, "w1", "tail-1");

    openMock.mockResolvedValueOnce("tail-2");
    await store.follow("w1", "session-1", "/var/log/other.log");

    expect(closeMock).toHaveBeenCalledWith("tail-1");
    emitLine("tail-1", "from the old stream");
    emitLine("tail-2", "from the new stream");
    expect(store.tailOf("w1")?.lines).toEqual(["from the new stream"]);
    expect(store.tailOf("w1")?.path).toBe("/var/log/other.log");
  });

  it("the buffer is bounded: the oldest lines fall off the top at the cap", () => {
    const buffer: string[] = [];
    for (let index = 0; index < TAIL_LINE_LIMIT + 50; index += 1) {
      appendTailLine(buffer, `line ${index}`);
    }
    expect(buffer.length).toBe(TAIL_LINE_LIMIT);
    expect(buffer[0]).toBe(`line ${50}`);
    expect(buffer[buffer.length - 1]).toBe(`line ${TAIL_LINE_LIMIT + 49}`);
  });

  it("a path that is not absolute on the far side, or carries a control character, is refused before the open", () => {
    expect(isValidTailPath("/var/log/syslog")).toBe(true);
    expect(isValidTailPath("var/log/syslog")).toBe(false);
    expect(isValidTailPath("")).toBe(false);
    expect(isValidTailPath("/var/log/a\tb.log")).toBe(false);
    expect(isValidTailPath("/var/log/a\nb.log")).toBe(false);
    // A newline pasted at the end is trimmed away first, the way the desktop shortcut reads a path.
    expect(isValidTailPath("/var/log/ok.log\n")).toBe(true);
  });

  it("the event names the store routes on are the batch-six contract", () => {
    expect(TAIL_LINE_EVENT).toBe("tail_line");
    expect(TAIL_END_EVENT).toBe("tail_end");
  });
});
