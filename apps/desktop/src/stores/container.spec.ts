/**
 * The container store: one engine per tab, and the streams that outlive a keystroke.
 *
 * What can only be seen here is the wiring the views depend on — the connection id written back onto
 * the tab so `terminals` can close it, an answer that arrives after its tab went away being thrown
 * away rather than applied, one stream subscription for every stream, and a stop that is real (the
 * line after it reaches nobody). The runtimes' own parsing is tested against their output in the
 * Rust crate; the folding of their progress lines into a bar is tested here, because that is where
 * it is written.
 */
import { createPinia, setActivePinia } from "pinia";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerConnect: vi.fn(),
  desktopEngineOpen: vi.fn(),
  containerDisconnect: vi.fn(async () => {}),
  containerList: vi.fn(async () => []),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(),
  containerNamespaces: vi.fn(async () => []),
  containerSetNamespace: vi.fn(async () => {}),
  containerAction: vi.fn(async () => "done"),
  containerRename: vi.fn(async () => {}),
  containerCreate: vi.fn(async () => {}),
  containerInspect: vi.fn(),
  containerLogsStart: vi.fn(),
  containerEventsStart: vi.fn(),
  containerChannels: vi.fn(async () => null),
  containerStreamStop: vi.fn(async () => {}),
  containerExecOpen: vi.fn(),
  containerImageInspect: vi.fn(),
  containerImageHistory: vi.fn(async () => []),
  containerImagePull: vi.fn(),
  containerImagePush: vi.fn(),
  containerImageRemove: vi.fn(async () => {}),
  containerImagePrune: vi.fn(async () => {}),
  containerImageTag: vi.fn(async () => {}),
  containerImageCommit: vi.fn(),
  containerRegistryLogin: vi.fn(async () => {}),
  onContainerStreamLine: vi.fn(),
  onContainerStreamEnd: vi.fn(),
}));

import {
  containerAction,
  containerChannels,
  containerConnect,
  containerDisconnect,
  containerEventsStart,
  containerImageCommit,
  containerImagePull,
  containerImages,
  containerList,
  containerLogsStart,
  containerRuntimeInfo,
  containerSetNamespace,
  containerStreamStop,
  desktopEngineOpen,
  onContainerStreamEnd,
  onContainerStreamLine,
} from "@/lib/backend/tauri";
import { normalizeShellError, type ShellError } from "@/lib/backend/errors";
import type { Translate } from "@/i18n/errors";
import {
  appendLogLine,
  applyImageProgress,
  CONTAINER_ACTIONS,
  describeContainerError,
  EVENT_RECONNECT_BASE_MS,
  EVENT_RECONNECT_MAX_MS,
  EVENT_REFRESH_DEBOUNCE_MS,
  EVENTS_DEGRADED_POLL_MS,
  eventMovesList,
  eventsReconnectDelay,
  filterContainers,
  filterImages,
  imageProgressPercent,
  imageRef,
  isBudgetRefusal,
  layerCounts,
  LOG_LINE_LIMIT,
  matchesImage,
  parseByteSize,
  parseEngineEvent,
  relatedContainers,
  shortId,
  splitLogLine,
  supportsCommit,
  supportsInsecure,
  supportsNamespace,
  supportsRename,
  supportsRestart,
  supportsTag,
  supportsTerminalOptions,
  useContainerStore,
  type LayerProgress,
} from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type {
  ContainerActionOutcome,
  ContainerImage,
  ContainerRuntimeInfo,
  ContainerStreamEnd,
  ContainerStreamLine,
  ContainerSummary,
} from "@/types/container";

const connectMock = vi.mocked(containerConnect);
const desktopEngineOpenMock = vi.mocked(desktopEngineOpen);
const disconnectMock = vi.mocked(containerDisconnect);
const listMock = vi.mocked(containerList);
const imagesMock = vi.mocked(containerImages);
const infoMock = vi.mocked(containerRuntimeInfo);
const namespaceSetMock = vi.mocked(containerSetNamespace);
const actionMock = vi.mocked(containerAction);
const logsStartMock = vi.mocked(containerLogsStart);
const eventsStartMock = vi.mocked(containerEventsStart);
const channelsMock = vi.mocked(containerChannels);
const streamStopMock = vi.mocked(containerStreamStop);
const pullMock = vi.mocked(containerImagePull);
const commitMock = vi.mocked(containerImageCommit);
const lineMock = vi.mocked(onContainerStreamLine);
const endMock = vi.mocked(onContainerStreamEnd);

function container(overrides: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    name: "web",
    image: "nginx:latest",
    state: "running",
    status: "Up 2 hours",
    ports: "0.0.0.0:8080->80/tcp",
    createdAt: "2026-11-10 10:00:00 +0000 UTC",
    ...overrides,
  };
}

function image(overrides: Partial<ContainerImage> = {}): ContainerImage {
  return {
    id: "sha256:abcdef0123456789abcdef0123456789",
    repository: "nginx",
    tag: "latest",
    size: "187MB",
    createdAt: "2026-11-10 10:00:00 +0000 UTC",
    ...overrides,
  };
}

function runtimeInfo(): ContainerRuntimeInfo {
  return {
    runtime: "docker",
    clientVersion: "28.0.0",
    serverVersion: "28.0.0",
    cpus: 8,
    memory: 16 * 1024 ** 3,
    containersTotal: 1,
    containersByState: [{ state: "running", count: 1 }],
    imagesTotal: 1,
    imagesTagged: 1,
    imagesDangling: 0,
  };
}

function tab(runtime: "docker" | "podman" | "nerdctl" | "wslc" = "docker"): ContainerTab {
  return {
    kind: "container",
    id: "tab-1",
    session: {
      id: "session-1",
      name: "docker on lab",
      protocol: "container",
      host: "",
      port: 0,
      user: "",
      auth: { method: "password", hasSecret: false },
      terminal: {
        terminalType: "xterm-256color",
        keepaliveSeconds: 0,
        encoding: "utf-8",
        backspace: "del",
        forwardAgent: false,
        record: false,
      },
      container: { runtime, transport: "local" },
      updatedAt: 0,
    },
    connectionId: null,
  };
}

/** A desktop session's engine tab: no container settings of its own, so the runtime is Docker. */
function desktopTab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-1",
    session: {
      id: "session-1",
      name: "lab desktop",
      protocol: "linuxDesk",
      host: "desk.test",
      port: 22,
      user: "root",
      auth: { method: "password", hasSecret: true },
      terminal: {
        terminalType: "xterm-256color",
        keepaliveSeconds: 0,
        encoding: "utf-8",
        backspace: "del",
        forwardAgent: false,
        record: false,
      },
      updatedAt: 0,
    },
    connectionId: null,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

let lineListener: ((payload: ContainerStreamLine) => void) | null = null;
let endListener: ((payload: ContainerStreamEnd) => void) | null = null;
let stopLine: () => void;
let stopEnd: () => void;

beforeEach(() => {
  setActivePinia(createPinia());
  vi.clearAllMocks();

  connectMock.mockResolvedValue("conn-1");
  desktopEngineOpenMock.mockResolvedValue("conn-1");
  listMock.mockResolvedValue([container()]);
  imagesMock.mockResolvedValue([image()]);
  infoMock.mockResolvedValue(runtimeInfo());
  logsStartMock.mockResolvedValue("log-1");
  eventsStartMock.mockResolvedValue("events-1");
  pullMock.mockResolvedValue("pull-1");
  streamStopMock.mockResolvedValue(undefined);

  lineListener = null;
  endListener = null;
  stopLine = vi.fn();
  stopEnd = vi.fn();
  lineMock.mockImplementation(async (listener) => {
    lineListener = listener;
    return stopLine;
  });
  endMock.mockImplementation(async (listener) => {
    endListener = listener;
    return stopEnd;
  });
});

afterEach(() => {
  useContainerStore().forget("tab-1");
});

function emitLine(streamId: string, line: string): void {
  if (!lineListener) {
    throw new Error("the store never subscribed to stream lines");
  }
  lineListener({ streamId, line });
}

function emitEnd(streamId: string, error?: string, yielded?: string): void {
  if (!endListener) {
    throw new Error("the store never subscribed to stream ends");
  }
  endListener({ streamId, error, yielded });
}

describe("container store connection", () => {
  it("opens one connection per tab, writes it onto the tab, and reads the three lists", async () => {
    const engine = useContainerStore();
    const opened = tab();

    await engine.connect(opened);

    expect(connectMock).toHaveBeenCalledWith("session-1");
    expect(opened.connectionId).toBe("conn-1");
    expect(engine.sessionFor("tab-1")?.connectionId).toBe("conn-1");
    expect(engine.sessionFor("tab-1")?.containers).toHaveLength(1);
    expect(engine.sessionFor("tab-1")?.images).toHaveLength(1);
    expect(engine.sessionFor("tab-1")?.info?.serverVersion).toBe("28.0.0");
    expect(engine.sessionFor("tab-1")?.loading).toBe(false);
  });

  it("does not open a second connection when the pane mounts twice", async () => {
    const engine = useContainerStore();
    const opened = tab();

    await engine.connect(opened);
    await engine.connect(opened);

    expect(connectMock).toHaveBeenCalledTimes(1);
  });

  it("opens a desktop session's engine on the connection the session already holds", async () => {
    const engine = useContainerStore();
    const opened = desktopTab();

    await engine.connect(opened);

    // A desktop session is already connected — the workbench holds that connection — so the engine
    // rides it rather than the session being asked to connect again as a container session is.
    expect(desktopEngineOpenMock).toHaveBeenCalledWith("session-1");
    expect(connectMock).not.toHaveBeenCalled();
    expect(opened.connectionId).toBe("conn-1");
    expect(engine.sessionFor("tab-1")?.connectionId).toBe("conn-1");
    expect(engine.sessionFor("tab-1")?.runtime).toBe("docker");
    expect(engine.sessionFor("tab-1")?.containers).toHaveLength(1);
  });

  it("a desktop session's refusal lands on the session like a container session's does", async () => {
    const engine = useContainerStore();
    const opened = desktopTab();
    desktopEngineOpenMock.mockRejectedValueOnce(new Error("no engine"));

    await engine.connect(opened);

    expect(engine.sessionFor("tab-1")?.connectionId).toBeNull();
    expect(engine.sessionFor("tab-1")?.error?.code).toBe("APP-INTERNAL");
    expect(opened.connectionId).toBeNull();
  });

  it("lets go of a connection that answered after its tab had gone", async () => {
    const engine = useContainerStore();
    const opened = tab();
    const answer = deferred<string>();
    connectMock.mockReturnValue(answer.promise);

    const opening = engine.connect(opened);
    engine.forget("tab-1");
    answer.resolve("conn-late");
    await opening;

    expect(disconnectMock).toHaveBeenCalledWith("conn-late");
    expect(engine.sessionFor("tab-1")).toBeUndefined();
    expect(opened.connectionId).toBeNull();
  });

  it("keeps a refusal on the session and lets a retry try again", async () => {
    const engine = useContainerStore();
    const opened = tab();
    connectMock.mockRejectedValueOnce(new Error("npipe is not there"));

    await engine.connect(opened);

    expect(engine.sessionFor("tab-1")?.connectionId).toBeNull();
    expect(engine.sessionFor("tab-1")?.error?.code).toBe("APP-INTERNAL");

    await engine.connect(opened);
    expect(engine.sessionFor("tab-1")?.connectionId).toBe("conn-1");
  });

  it("disconnects when it is closed, and forgets without disconnecting when the pane unmounts", async () => {
    const engine = useContainerStore();
    const opened = tab();

    await engine.connect(opened);
    engine.forget("tab-1");
    expect(disconnectMock).not.toHaveBeenCalled();

    await engine.connect(opened);
    await engine.close("tab-1");
    expect(disconnectMock).toHaveBeenCalledWith("conn-1");
    expect(engine.sessionFor("tab-1")).toBeUndefined();
  });
});

describe("container store streams", () => {
  it("subscribes to the stream events once, however many streams are started", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());

    logsStartMock.mockResolvedValueOnce("log-1").mockResolvedValueOnce("log-2");
    await engine.startLogs("tab-1", "c1", 500, false, { onLine: () => {}, onEnd: () => {} });
    await engine.startLogs("tab-1", "c2", 500, false, { onLine: () => {}, onEnd: () => {} });

    expect(lineMock).toHaveBeenCalledTimes(1);
    expect(endMock).toHaveBeenCalledTimes(1);
  });

  it("routes lines by stream id and stops routing them once the stream is stopped", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());

    const lines: string[] = [];
    const ended: (string | undefined)[] = [];
    await engine.startLogs("tab-1", "c1", 500, false, {
      onLine: (line) => lines.push(line),
      onEnd: (error) => ended.push(error),
    });

    emitLine("log-1", "first");
    expect(lines).toEqual(["first"]);

    await engine.stopStream("log-1");
    expect(streamStopMock).toHaveBeenCalledWith("log-1");
    emitLine("log-1", "after the stop");
    expect(lines).toEqual(["first"]);

    emitEnd("log-1", "ignored");
    expect(ended).toEqual([]);
  });

  it("hands the end of a stream to its own view, and only to it", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());

    const first: (string | undefined)[] = [];
    const second: (string | undefined)[] = [];
    logsStartMock.mockResolvedValueOnce("log-1").mockResolvedValueOnce("log-2");
    await engine.startLogs("tab-1", "c1", 500, false, { onLine: () => {}, onEnd: (error) => first.push(error) });
    await engine.startLogs("tab-1", "c2", 500, false, { onLine: () => {}, onEnd: (error) => second.push(error) });

    emitEnd("log-1", "the container went away");
    expect(first).toEqual(["the container went away"]);
    expect(second).toEqual([]);
  });

  it("stops every stream a session owns when the pane forgets it, and lets the listener go", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    logsStartMock.mockResolvedValueOnce("log-1").mockResolvedValueOnce("log-2");
    await engine.startLogs("tab-1", "c1", 500, false, { onLine: () => {}, onEnd: () => {} });
    await engine.startLogs("tab-1", "c2", 500, false, { onLine: () => {}, onEnd: () => {} });

    engine.forget("tab-1");
    await Promise.resolve();

    expect(streamStopMock.mock.calls.map((call) => call[0]).sort()).toEqual(["log-1", "log-2"]);
    expect(stopLine).toHaveBeenCalled();
    expect(stopEnd).toHaveBeenCalled();
  });
});

describe("the engine's event stream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the store's un-awaited event open finish: its chain is microtasks only. */
  async function flushOpens(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  function infoWithEvents(): ContainerRuntimeInfo {
    return { ...runtimeInfo(), eventsAvailable: true };
  }

  it("follows an engine that has events: subscribes once, realigns on open, and refreshes after a burst", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();

    expect(eventsStartMock).toHaveBeenCalledTimes(1);
    expect(eventsStartMock).toHaveBeenCalledWith("conn-1");
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBe("events-1");
    const readsAfterConnect = listMock.mock.calls.length;

    // A burst of events (one restart dies and is destroyed) is one read, not one per event.
    emitLine("events-1", JSON.stringify({ eventType: "container", action: "die", id: "abc" }));
    emitLine("events-1", JSON.stringify({ eventType: "container", action: "destroy", id: "abc" }));
    expect(listMock.mock.calls.length, "the burst has not settled yet").toBe(readsAfterConnect);
    await vi.advanceTimersByTimeAsync(EVENT_REFRESH_DEBOUNCE_MS + 10);
    expect(listMock.mock.calls.length).toBe(readsAfterConnect + 1);

    // An image event names nothing a container row shows, so the list does not move for it.
    emitLine("events-1", JSON.stringify({ eventType: "image", action: "pull", id: "sha256:beef" }));
    await vi.advanceTimersByTimeAsync(EVENT_REFRESH_DEBOUNCE_MS + 10);
    expect(listMock.mock.calls.length).toBe(readsAfterConnect + 1);
  });

  it("reconnects an ended stream with a growing delay and realigns once it is back", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    eventsStartMock.mockClear();
    eventsStartMock.mockResolvedValueOnce("events-1").mockResolvedValueOnce("events-2");
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();

    emitEnd("events-1");
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBeNull();

    // The first wait is the base: nothing happens just before it, the ask goes out at it.
    await vi.advanceTimersByTimeAsync(EVENT_RECONNECT_BASE_MS - 10);
    expect(eventsStartMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(eventsStartMock).toHaveBeenCalledTimes(2);
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBe("events-2");
    // The read that converges what the broken stream missed is forced, even over a read in flight.
    expect(listMock).toHaveBeenCalledWith("conn-1");
  });

  it("an engine without the events bit is never asked, and never becomes a poll", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();

    expect(eventsStartMock).not.toHaveBeenCalled();
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBeNull();
    expect(engine.sessionFor("tab-1")?.error).toBeNull();
  });

  it("lets go of the stream and its timers when the tab goes away", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();

    engine.forget("tab-1");
    await vi.advanceTimersByTimeAsync(EVENT_RECONNECT_MAX_MS * 2);

    expect(streamStopMock).toHaveBeenCalledWith("events-1");
    expect(eventsStartMock, "no reconnect after the session is gone").toHaveBeenCalledTimes(1);
  });
});

describe("the events stream under the channel budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Lets the store's un-awaited event open finish: its chain is microtasks only. */
  async function flushOpens(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
  }

  function infoWithEvents(): ContainerRuntimeInfo {
    return { ...runtimeInfo(), eventsAvailable: true };
  }

  /** The envelope a budget refusal travels as: the arithmetic rides the message params. */
  function budgetRefusal(): ShellError {
    return normalizeShellError(
      {
        code: "SSH-CHANNEL-REFUSED",
        messageKey: "errors.ssh.channelRefused",
        messageParams: { host: "host.example", port: "22", held: "8", limit: "8" },
        detail: "a channel for the engine's events was refused by this build's own channel budget",
        diagnostics: { held: "8", limit: "8", holders: "logs:8" },
        origin: { subsystem: "ssh" },
      },
      "container_events_start",
    );
  }

  it("a yielded end degrades to the polling refresh and never reconnects on its own", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBe("events-1");

    // The backend spent the events stream's channel on something else: the end event says which
    // holder went, and the answer is the polling refresh, not a reconnect into a full budget.
    emitEnd("events-1", undefined, "events");
    expect(engine.sessionFor("tab-1")?.eventsDegraded).toBe(true);
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBeNull();
    const readsAtDegrade = listMock.mock.calls.length;

    // Six poll intervals fit in the old reconnect ceiling; not one reconnect happens in them.
    const waits = (EVENT_RECONNECT_MAX_MS * 2) / EVENTS_DEGRADED_POLL_MS;
    await vi.advanceTimersByTimeAsync(EVENT_RECONNECT_MAX_MS * 2);
    expect(eventsStartMock, "nothing reconnects on its own").toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls.length).toBe(readsAtDegrade + waits);

    // The degraded refresh stands in for the engine's push: one read per interval.
    await vi.advanceTimersByTimeAsync(EVENTS_DEGRADED_POLL_MS);
    expect(listMock.mock.calls.length).toBe(readsAtDegrade + waits + 1);
  });

  it("a budget refusal on the stream's own open degrades the same way", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    eventsStartMock.mockRejectedValueOnce(budgetRefusal());
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();

    expect(engine.sessionFor("tab-1")?.eventsDegraded).toBe(true);
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBeNull();

    await vi.advanceTimersByTimeAsync(EVENT_RECONNECT_MAX_MS * 2);
    expect(eventsStartMock, "the backoff is not walked into the same wall").toHaveBeenCalledTimes(1);
    expect(listMock.mock.calls.length, "the polling refresh covers what the stream would have").toBeGreaterThan(1);
  });

  it("a refusal that is not the budget's keeps the reconnect backoff", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    eventsStartMock.mockClear();
    eventsStartMock
      .mockRejectedValueOnce(
        normalizeShellError({ code: "SSH-UNREACHABLE", messageKey: "errors.ssh.unreachable" }, "c"),
      )
      .mockResolvedValueOnce("events-2");
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();

    expect(engine.sessionFor("tab-1")?.eventsDegraded).toBe(false);
    await vi.advanceTimersByTimeAsync(EVENT_RECONNECT_BASE_MS);
    expect(eventsStartMock).toHaveBeenCalledTimes(2);
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBe("events-2");
    expect(engine.sessionFor("tab-1")?.eventsDegraded).toBe(false);
  });

  it("a stream that comes back ends the degraded stretch with it", async () => {
    infoMock.mockResolvedValue(infoWithEvents());
    eventsStartMock.mockRejectedValueOnce(budgetRefusal()).mockResolvedValueOnce("events-2");
    const engine = useContainerStore();
    await engine.connect(tab());
    await flushOpens();
    expect(engine.sessionFor("tab-1")?.eventsDegraded).toBe(true);
    const readsAfterDegrade = listMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(EVENTS_DEGRADED_POLL_MS);
    expect(listMock.mock.calls.length).toBeGreaterThan(readsAfterDegrade);

    // The person closed other streams and says so: the resume opens the stream again, and the
    // polling refresh stops standing in.
    eventsStartMock.mockClear();
    listMock.mockClear();
    engine.resumeEventsStream("tab-1");
    await flushOpens();
    expect(eventsStartMock).toHaveBeenCalledTimes(1);
    expect(engine.sessionFor("tab-1")?.eventsStreamId).toBe("events-2");
    expect(engine.sessionFor("tab-1")?.eventsDegraded).toBe(false);

    const readsAfterResume = listMock.mock.calls.length;
    await vi.advanceTimersByTimeAsync(EVENTS_DEGRADED_POLL_MS * 2);
    expect(listMock.mock.calls.length, "the engine's push is back, so no poll refresh runs beside it").toBe(
      readsAfterResume,
    );
  });

  it("answers the budget question for the view that is about to open several streams", async () => {
    channelsMock.mockResolvedValue({ limit: 8, held: 5, free: 3, holders: [{ kind: "logs", held: 5 }] });
    const engine = useContainerStore();
    await engine.connect(tab());

    const budget = await engine.channels("tab-1");
    expect(budget).toEqual({ limit: 8, held: 5, free: 3, holders: [{ kind: "logs", held: 5 }] });

    // An engine on this machine holds no channels: the backend answers null, and so does a tab
    // that has nothing to ask about.
    channelsMock.mockResolvedValue(null);
    expect(await engine.channels("tab-1")).toBeNull();
    expect(await engine.channels("tab-that-never-was")).toBeNull();
  });
});

describe("budget refusal rendering", () => {
  /** A translate that makes the key and its params visible in the answer. */
  const translate: Translate = (key, params) => `${key}:${JSON.stringify(params ?? null)}`;

  it("a budget refusal renders its own sentence with the arithmetic in it", () => {
    const error = normalizeShellError(
      {
        code: "SSH-CHANNEL-REFUSED",
        messageKey: "errors.ssh.channelRefused",
        messageParams: { host: "h", port: "22", held: "8", limit: "8" },
        origin: { subsystem: "ssh" },
      },
      "c",
    );
    expect(isBudgetRefusal(error)).toBe(true);
    const described = describeContainerError(translate, error);
    expect(described.message).toBe('container.errors.channelBudget:{"held":"8","limit":"8"}');
    expect(described.code).toBe("SSH-CHANNEL-REFUSED");
  });

  it("a server refusal and every other error keep the sentences they always had", () => {
    const serverRefusal = normalizeShellError(
      {
        code: "SSH-CHANNEL-REFUSED",
        messageKey: "errors.ssh.channelRefused",
        messageParams: { host: "h", port: "22" },
        origin: { subsystem: "ssh" },
      },
      "c",
    );
    expect(isBudgetRefusal(serverRefusal)).toBe(false);
    expect(describeContainerError(translate, serverRefusal).message).toBe(
      'errors.ssh.channelRefused:{"host":"h","port":"22"}',
    );

    expect(isBudgetRefusal(new Error("nothing about channels"))).toBe(false);
    const other = normalizeShellError(
      {
        code: "SSH-UNREACHABLE",
        messageKey: "errors.ssh.unreachable",
        messageParams: { host: "h", port: "22" },
        origin: { subsystem: "ssh" },
      },
      "c",
    );
    expect(describeContainerError(translate, other).message).toBe('errors.ssh.unreachable:{"host":"h","port":"22"}');
  });
});

describe("container store actions", () => {
  it("passes the acknowledgement of a destructive action through and reads the list again", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    listMock.mockClear();

    await engine.action("tab-1", "c1", CONTAINER_ACTIONS.stop, true);

    expect(actionMock).toHaveBeenCalledWith("conn-1", "c1", "stop", true);
    expect(listMock).toHaveBeenCalledWith("conn-1");
  });

  it("keeps a refusal from an action on the session and rethrows it", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    actionMock.mockRejectedValueOnce(new Error("no such container"));

    await expect(engine.action("tab-1", "c1", CONTAINER_ACTIONS.remove, true)).rejects.toMatchObject({
      code: "APP-INTERNAL",
    });
    expect(engine.sessionFor("tab-1")?.error?.code).toBe("APP-INTERNAL");
  });

  it("a second ask for the same write while it is still on its way meets the first call", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    let release: ((value: ContainerActionOutcome) => void) | undefined;
    const gate = new Promise<ContainerActionOutcome>((resolve) => {
      release = resolve;
    });
    actionMock.mockImplementationOnce(() => gate);

    const first = engine.action("tab-1", "c1", CONTAINER_ACTIONS.stop, true);
    const second = engine.action("tab-1", "c1", CONTAINER_ACTIONS.stop, true);
    release?.("done");
    await Promise.all([first, second]);

    expect(actionMock, "a double click is one stop, not two").toHaveBeenCalledTimes(1);
  });

  it("a different container or a settled action still makes its own call", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    await engine.action("tab-1", "c1", CONTAINER_ACTIONS.stop, true);

    await engine.action("tab-1", "c2", CONTAINER_ACTIONS.stop, true);
    expect(actionMock).toHaveBeenCalledTimes(2);

    await engine.action("tab-1", "c1", CONTAINER_ACTIONS.remove, true);
    expect(actionMock).toHaveBeenCalledTimes(3);
  });

  it("switches namespace in the engine and reads both lists again", async () => {
    const engine = useContainerStore();
    await engine.connect(tab("nerdctl"));
    listMock.mockClear();
    imagesMock.mockClear();

    await engine.setNamespace("tab-1", "k8s.io");

    expect(namespaceSetMock).toHaveBeenCalledWith("conn-1", "k8s.io");
    expect(engine.sessionFor("tab-1")?.namespace).toBe("k8s.io");
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(imagesMock).toHaveBeenCalledTimes(1);
  });

  it("sends a commit with the acknowledgement the dialog collected", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    commitMock.mockResolvedValue("sha256:beef");

    await engine.commit("tab-1", { containerId: "c1", image: "web:snapshot" });

    expect(commitMock).toHaveBeenCalledWith("conn-1", { containerId: "c1", image: "web:snapshot" }, true);
  });
});

describe("image transfers", () => {
  it("keeps one row per transfer, folds the runtime's lines into progress, and reloads images when a pull ends", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    imagesMock.mockClear();

    await engine.pullImage("tab-1", { image: "redis:7" });
    const task = engine.sessionFor("tab-1")?.tasks[0];
    expect(task?.status).toBe("running");
    expect(task?.streamId).toBe("pull-1");

    emitLine("pull-1", "3f4e: Pulling fs layer");
    emitLine("pull-1", "3f4e: Downloading [====>   ]  5.25MB/52.5MB");
    emitLine("pull-1", "9ab0: Pulling fs layer");
    emitLine("pull-1", "9ab0: Pull complete");

    expect(task?.lines).toHaveLength(4);
    expect(layerCounts(task?.layers ?? new Map<string, LayerProgress>())).toEqual({ done: 1, total: 2 });

    emitLine("pull-1", "3f4e: Pull complete");
    expect(imageProgressPercent(task?.layers ?? new Map<string, LayerProgress>())).toBe(100);

    emitEnd("pull-1");
    expect(task?.status).toBe("done");
    expect(task?.streamId).toBeNull();
    expect(imagesMock).toHaveBeenCalledTimes(1);
  });

  it("marks a transfer stopped without letting its late end event overwrite the answer", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());

    await engine.pullImage("tab-1", { image: "redis:7" });
    const task = engine.sessionFor("tab-1")?.tasks[0];
    if (!task) {
      throw new Error("the transfer never appeared");
    }

    await engine.stopTask("tab-1", task.id);
    expect(task.status).toBe("stopped");
    expect(streamStopMock).toHaveBeenCalledWith("pull-1");

    emitEnd("pull-1", "killed");
    expect(task.status).toBe("stopped");
    expect(task.streamError).toBeNull();
  });

  it("keeps a refusal to start on the row rather than throwing at the panel", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    pullMock.mockRejectedValueOnce(new Error("registry unreachable"));

    await engine.pullImage("tab-1", { image: "redis:7" });

    const task = engine.sessionFor("tab-1")?.tasks[0];
    expect(task?.status).toBe("failed");
    expect(task?.failure?.code).toBe("APP-INTERNAL");
    expect(task?.endedAt).toBeGreaterThan(0);
  });

  it("removes a finished row but leaves a running one alone", async () => {
    const engine = useContainerStore();
    await engine.connect(tab());
    await engine.pullImage("tab-1", { image: "redis:7" });
    const task = engine.sessionFor("tab-1")?.tasks[0];
    if (!task) {
      throw new Error("the transfer never appeared");
    }

    engine.clearTask("tab-1", task.id);
    expect(engine.sessionFor("tab-1")?.tasks).toHaveLength(1);

    emitEnd("pull-1");
    engine.clearTask("tab-1", task.id);
    expect(engine.sessionFor("tab-1")?.tasks).toHaveLength(0);
  });
});

describe("runtime capabilities", () => {
  it("draws only the actions a runtime can carry out", () => {
    expect(supportsRestart("wslc")).toBe(false);
    expect(supportsRestart("podman")).toBe(true);
    expect(supportsRename("wslc")).toBe(false);
    expect(supportsCommit("docker")).toBe(true);
    expect(supportsCommit("podman")).toBe(false);
    expect(supportsTag("wslc")).toBe(false);
    expect(supportsInsecure("docker")).toBe(false);
    expect(supportsInsecure("nerdctl")).toBe(true);
    expect(supportsNamespace("nerdctl")).toBe(true);
    expect(supportsNamespace("docker")).toBe(false);
    expect(supportsTerminalOptions("wslc")).toBe(false);
  });
});

describe("pure helpers", () => {
  it("shortens an id the way the runtime prints it, without the digest prefix", () => {
    expect(shortId("sha256:abcdef0123456789")).toBe("abcdef012345");
    expect(shortId("sha256:abc")).toBe("abc");
    expect(shortId("abcdef0123456789")).toBe("abcdef012345");
  });

  it("names an image by its tag, and by its id when it has no tag left", () => {
    expect(imageRef(image())).toBe("nginx:latest");
    expect(imageRef(image({ tag: "<none>" }))).toBe("sha256:abcdef0123456789abcdef0123456789");
    expect(imageRef(image({ repository: "<none>" }))).toBe("sha256:abcdef0123456789abcdef0123456789");
  });

  it("recognises a container by the tag it was started from and by an image id", () => {
    expect(matchesImage(container(), "nginx:latest")).toBe(true);
    expect(matchesImage(container({ image: "abcdef0123456789" }), "sha256:abcdef012345")).toBe(true);
    expect(matchesImage(container(), "redis:7")).toBe(false);
    expect(relatedContainers([container(), container({ id: "b", image: "redis:7" })], image())).toBe(1);
  });

  it("filters containers by running state, state, image and text together", () => {
    const containers = [
      container(),
      container({ id: "b", name: "worker", state: "exited", image: "redis:7" }),
      container({ id: "c", name: "sidecar", state: "paused" }),
    ];

    expect(filterContainers(containers, { runningOnly: true })).toHaveLength(1);
    expect(filterContainers(containers, { runningOnly: true, state: "exited" })).toHaveLength(0);
    expect(filterContainers(containers, { state: "paused" }).map((entry) => entry.name)).toEqual(["sidecar"]);
    expect(filterContainers(containers, { image: "redis:7" }).map((entry) => entry.name)).toEqual(["worker"]);
    expect(filterContainers(containers, { text: "SIDECAR" }).map((entry) => entry.name)).toEqual(["sidecar"]);
    expect(filterContainers(containers, { text: "0123456789abcdef" })).toHaveLength(1);
  });

  it("filters images by repository, tag or id and leaves them in order", () => {
    const images = [image(), image({ id: "sha256:beef", repository: "redis", tag: "7" })];
    expect(filterImages(images, "")).toHaveLength(2);
    expect(filterImages(images, "redis")).toHaveLength(1);
    expect(filterImages(images, "beef")).toHaveLength(1);
    expect(filterImages(images, "nothing")).toHaveLength(0);
  });

  it("reads the byte counts out of a runtime line", () => {
    expect(parseByteSize("5", "B")).toBe(5);
    expect(parseByteSize("5.25", "MB")).toBe(Math.round(5.25 * 1024 ** 2));
    expect(parseByteSize("not a number", "MB")).toBe(0);
  });

  it("folds both the per-layer and the older aggregate output into one bar", () => {
    const layers = new Map<string, LayerProgress>();
    expect(imageProgressPercent(layers)).toBeNull();

    applyImageProgress(layers, "3f4e: Pulling fs layer");
    applyImageProgress(layers, "3f4e: Downloading [==>   ]  2MB/4MB");
    expect(imageProgressPercent(layers)).toBe(50);

    applyImageProgress(layers, "this is not a layer line");
    expect(imageProgressPercent(layers)).toBe(50);

    applyImageProgress(layers, "3f4e: Pull complete");
    expect(imageProgressPercent(layers)).toBe(100);

    const aggregate = new Map<string, LayerProgress>();
    applyImageProgress(aggregate, "Pulling fs layer");
    applyImageProgress(aggregate, "Downloading [=>    ]  1MB/2MB");
    applyImageProgress(aggregate, "Download complete");
    expect(imageProgressPercent(aggregate)).toBe(100);
  });

  it("splits a log line's timestamp from its message only when there is one", () => {
    expect(splitLogLine("2026-11-10T10:00:00.123456789Z hello there")).toEqual({
      timestamp: "2026-11-10T10:00:00.123456789Z",
      message: "hello there",
    });
    expect(splitLogLine("hello there")).toEqual({ timestamp: "", message: "hello there" });
  });

  it("keeps a log buffer bounded, dropping the oldest lines", () => {
    const buffer: string[] = [];
    for (let index = 0; index < LOG_LINE_LIMIT + 5; index += 1) {
      appendLogLine(buffer, `line ${index}`);
    }
    expect(buffer).toHaveLength(LOG_LINE_LIMIT);
    expect(buffer[0]).toBe("line 5");
  });

  it("bounds a merged view's entries the same way, whatever the entry carries", () => {
    const buffer: { line: string; source: string | null }[] = [];
    for (let index = 0; index < LOG_LINE_LIMIT + 5; index += 1) {
      appendLogLine(buffer, { line: `line ${index}`, source: index % 2 === 0 ? "web" : null });
    }
    expect(buffer).toHaveLength(LOG_LINE_LIMIT);
    expect(buffer[0]).toEqual({ line: "line 5", source: null });
    expect(buffer[1]).toEqual({ line: "line 6", source: "web" });
  });

  it("reads an engine event off a stream line, and refuses one that names nothing", () => {
    expect(parseEngineEvent('{"eventType":"container","action":"die","id":"abc","name":"web"}')).toEqual({
      eventType: "container",
      action: "die",
      id: "abc",
      name: "web",
    });
    expect(parseEngineEvent('{"id":"abc"}')).toEqual({ id: "abc" });
    expect(parseEngineEvent("not json")).toBeNull();
    expect(parseEngineEvent("{}")).toBeNull();
    expect(parseEngineEvent('{"action":"die"}')).toBeNull();
  });

  it("lets a container event move the list and leaves every other kind alone", () => {
    expect(eventMovesList({ eventType: "container", action: "die", id: "a" })).toBe(true);
    // A runtime that says no kind at all is speaking its container stream by construction.
    expect(eventMovesList({ action: "die", id: "a" })).toBe(true);
    expect(eventMovesList({ eventType: "image", action: "pull", id: "sha256:beef" })).toBe(false);
    expect(eventMovesList({ eventType: "network", action: "connect", id: "n1" })).toBe(false);
  });

  it("backs off an ended event stream geometrically, up to the ceiling", () => {
    expect(eventsReconnectDelay(1)).toBe(EVENT_RECONNECT_BASE_MS);
    expect(eventsReconnectDelay(2)).toBe(EVENT_RECONNECT_BASE_MS * 2);
    expect(eventsReconnectDelay(3)).toBe(EVENT_RECONNECT_BASE_MS * 4);
    expect(eventsReconnectDelay(6)).toBe(EVENT_RECONNECT_MAX_MS);
    expect(eventsReconnectDelay(20)).toBe(EVENT_RECONNECT_MAX_MS);
  });
});
