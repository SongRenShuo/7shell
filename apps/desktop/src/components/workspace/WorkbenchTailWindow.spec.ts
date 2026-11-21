/**
 * The desktop's log-tracking window, as it is met: the ask, the reading, and the long-stream rule.
 *
 * The tail store's routing has a suite of its own; what is checked here is what the window adds —
 * that a path is validated before it is sent, that the reading draws the lines and names the count,
 * that the follow button means follow and pause both, that a window nobody is looking at pauses
 * itself and resumes when it is back, and that a window going away cancels the stream outright.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));

// The stream events are fired by hand, exactly as the far side writes them.
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

import WorkbenchTailWindow from "@/components/workspace/WorkbenchTailWindow.vue";
import { i18n } from "@/i18n";
import { fileTailClose, fileTailOpen } from "@/lib/backend/tauri";

const openMock = vi.mocked(fileTailOpen);
const closeMock = vi.mocked(fileTailClose);

let app: App | undefined;
let host: HTMLDivElement | undefined;

function emitLine(tailId: string, line: string): void {
  const snapshot = [...lineListeners];
  for (const handler of snapshot) {
    handler({ payload: { tailId, line } });
  }
}

/** Draws the window over a reactive props record, because `active` flips underneath it. */
async function mount(props: { sessionId: string; windowId: string; active: boolean }): Promise<void> {
  app?.unmount();
  host?.remove();

  const pinia = createPinia();
  setActivePinia(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(WorkbenchTailWindow, props) });
  app.use(i18n);
  app.use(pinia);
  app.mount(host);
  await nextTick();
}

const windowProps = () => ({ sessionId: "session-1", windowId: "w1", active: true });

beforeEach(() => {
  lineListeners.length = 0;
  endListeners.length = 0;
  openMock.mockReset();
  closeMock.mockClear();
  closeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function windowBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-workbench-tail-window]");
  if (!body) {
    throw new Error("the tail window was not drawn");
  }
  return body;
}

function followButton(): HTMLButtonElement {
  const button = windowBody().querySelector<HTMLButtonElement>("[data-workbench-tail-follow]");
  if (!button) {
    throw new Error("the follow button was not drawn");
  }
  return button;
}

function pathInput(): HTMLInputElement {
  const input = windowBody().querySelector<HTMLInputElement>("input[type='text']");
  if (!input) {
    throw new Error("the path field was not drawn");
  }
  return input;
}

describe("the desktop's tail window", () => {
  it("draws the ask while idle: the path field, the sizes and the scenario sentences", async () => {
    await mount(windowProps());

    expect(pathInput()).toBeDefined();
    expect(windowBody().textContent).toContain("/var/log/syslog");
    expect(windowBody().textContent).toContain("/var/log/nginx/access.log");
    // The pause is not free, and the window says so before anybody finds out the hard way.
    expect(windowBody().textContent).toContain("missed");
  });

  it("refuses a relative path before the open, in the form rather than at the far side", async () => {
    await mount(windowProps());
    pathInput().value = "var/log/syslog";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();

    expect(followButton().disabled).toBe(true);
    expect(windowBody().textContent).toContain("absolute path");
    expect(openMock).not.toHaveBeenCalled();
  });

  it("asks with the desktop's accent primary button, in the form's own rhythm", async () => {
    await mount(windowProps());

    // The accent face is the docker window's create and the shared primary's voice; a full-width
    // bar would be a second button language inside the same desktop.
    expect(followButton().className).toContain("bg-[var(--workbench-accent)]");
    expect(followButton().className).not.toContain("w-full");
  });

  it("follows an absolute path: the open carries the size, and the reading is drawn", async () => {
    openMock.mockResolvedValue("tail-1");
    await mount(windowProps());
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith("session-1", "/var/log/app.log", 200);
    });

    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });
    expect(windowBody().textContent).toContain("/var/log/app.log");
    // The button now means pause, and the stop is beside it.
    expect(followButton().textContent).toContain("Pause");
    expect(windowBody().textContent).toContain("Stop");
  });

  it("arriving lines are drawn and counted", async () => {
    openMock.mockResolvedValue("tail-1");
    await mount(windowProps());
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });

    emitLine("tail-1", "first line");
    emitLine("tail-1", "second line");
    await nextTick();

    expect(windowBody().querySelector("[data-workbench-tail-lines]")?.textContent).toContain("second line");
    expect(windowBody().textContent).toContain("2 lines");
  });

  it("the follow button pauses a live stream, and the stream is really closed", async () => {
    openMock.mockResolvedValue("tail-1");
    await mount(windowProps());
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });

    followButton().click();
    await vi.waitFor(() => {
      expect(closeMock).toHaveBeenCalledWith("tail-1");
    });

    // The reading stays — pause keeps the lines — and the notice says what a pause costs.
    expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    expect(windowBody().textContent).toContain("Paused");
  });

  it("the long-stream rule: a window nobody is looking at pauses itself, and resumes in front", async () => {
    openMock.mockResolvedValue("tail-1");
    // Reactive, so the watcher in the window sees the flip.
    const props = reactive({ ...windowProps() });
    await mount(props);
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });

    // Minimised, or the desktop tab hidden: the host turns `active` off, the stream pauses.
    props.active = false;
    await nextTick();
    await vi.waitFor(() => {
      expect(closeMock).toHaveBeenCalledWith("tail-1");
    });

    // Back in front: the same path is opened again.
    openMock.mockResolvedValue("tail-2");
    props.active = true;
    await nextTick();
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenLastCalledWith("session-1", "/var/log/app.log", 200);
    });
    await vi.waitFor(() => {
      expect(followButton().textContent).toContain("Pause");
    });
  });

  it("lines written while the window is hidden never reach the buffer", async () => {
    openMock.mockResolvedValue("tail-1");
    // Reactive, so the watcher in the window sees the flip.
    const props = reactive({ ...windowProps() });
    await mount(props);
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });

    for (const line of ["read in front", "also read in front"]) {
      emitLine("tail-1", line);
    }
    await nextTick();

    const { useTailStore } = await import("@/stores/tail");
    const tailStore = useTailStore();
    expect(tailStore.tails["w1"]?.lines, "what was read while the window was watched").toEqual([
      "read in front",
      "also read in front",
    ]);

    props.active = false;
    await nextTick();
    await vi.waitFor(() => {
      expect(closeMock).toHaveBeenCalledWith("tail-1");
    });

    for (let index = 0; index < 3; index += 1) {
      emitLine("tail-1", `written while hidden ${index}`);
    }
    await nextTick();
    expect(
      tailStore.tails["w1"]?.lines,
      "the stream is closed behind the fold, so nothing arrives and the buffer holds",
    ).toEqual(["read in front", "also read in front"]);
    expect(tailStore.tails["w1"]?.status, "and the window says it is paused, not following").toBe("paused");
  });

  it("stop throws the reading away and the window is the ask again", async () => {
    openMock.mockResolvedValue("tail-1");
    await mount(windowProps());
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });

    const stop = [...windowBody().querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Stop");
    expect(stop).not.toBeUndefined();
    stop?.click();
    await vi.waitFor(() => {
      expect(closeMock).toHaveBeenCalledWith("tail-1");
    });

    await vi.waitFor(() => {
      expect(pathInput()).toBeDefined();
    });
    expect(windowBody().querySelector("[data-workbench-tail-lines]")).toBeNull();
  });

  it("the window going away cancels the stream — a closed window leaves nothing reading", async () => {
    openMock.mockResolvedValue("tail-1");
    await mount(windowProps());
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();
    });

    app?.unmount();
    app = undefined;
    expect(closeMock).toHaveBeenCalledWith("tail-1");
  });
});

describe("the tail window's line frequency", () => {
  /** The microtasks a click's async trail needs before the store has settled, on fake timers. */
  async function settle(): Promise<void> {
    for (let turn = 0; turn < 6; turn += 1) {
      await Promise.resolve();
    }
    await nextTick();
  }

  async function followAbsolutePath(): Promise<void> {
    pathInput().value = "/var/log/app.log";
    pathInput().dispatchEvent(new Event("input"));
    await nextTick();
    followButton().click();
    await settle();
  }

  // The sampling is a one-second schedule, so the test drives the schedule itself: the assertions
  // are on what was asked to happen per tick, never on how long anything took.
  it("samples once a second while following, stops when paused, and empties for a fresh ask", async () => {
    vi.useFakeTimers();
    try {
      openMock.mockResolvedValue("tail-1");
      await mount(windowProps());
      await followAbsolutePath();
      expect(windowBody().querySelector("[data-workbench-tail-lines]")).not.toBeNull();

      // Nothing is drawn before the first second has answered.
      expect(windowBody().querySelector("[data-workbench-tail-frequency]")).toBeNull();

      emitLine("tail-1", "line one");
      emitLine("tail-1", "line two");
      await nextTick();

      // The first tick closes the first interval: two lines landed in it.
      vi.advanceTimersByTime(1000);
      await nextTick();
      expect(windowBody().querySelector("[data-workbench-tail-frequency]")).not.toBeNull();

      // A quiet second is a sample of zero — the bar keeps its width, the line stays honest.
      vi.advanceTimersByTime(1000);
      await nextTick();
      const bars = windowBody().querySelectorAll("[data-workbench-tail-frequency] span");
      expect(bars.length).toBe(2);

      // Paused: the schedule stops; ticks pass and no third sample is taken.
      followButton().click();
      await settle();
      vi.advanceTimersByTime(5000);
      await nextTick();
      expect(windowBody().querySelectorAll("[data-workbench-tail-frequency] span").length).toBe(2);

      // Stop for good: the window is the ask again, and a fresh ask starts from an empty bar.
      const stop = [...windowBody().querySelectorAll("button")].find((entry) => entry.textContent?.trim() === "Stop");
      stop?.click();
      await settle();
      expect(windowBody().querySelector("[data-workbench-tail-frequency]")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
