/**
 * The container drawer: what the detail says, and what the log view does with the lines it is given.
 *
 * The log view has three behaviours a store test cannot see — following the tail, pausing without
 * discarding what arrived, and letting go of the stream when it closes — and each of them is
 * observable here by the only evidence that matters: what is on screen and what was sent back.
 *
 * The same evidence covers what came later: a search that reads the buffer without touching the
 * streams and keeps matching the lines that land while it runs, a merge that prefixes each line
 * with the container that wrote it, and exports that hand out exactly what the view is showing.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerConnect: vi.fn(async () => "conn-1"),
  containerDisconnect: vi.fn(async () => {}),
  containerList: vi.fn(async () => []),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(async () => {
    throw new Error("nothing to say");
  }),
  containerNamespaces: vi.fn(async () => []),
  containerSetNamespace: vi.fn(async () => {}),
  containerAction: vi.fn(async () => "done"),
  containerRename: vi.fn(async () => {}),
  containerCreate: vi.fn(async () => {}),
  containerInspect: vi.fn(),
  containerLogsStart: vi.fn(async () => "log-1"),
  containerStreamStop: vi.fn(async () => {}),
  containerExecOpen: vi.fn(async () => "pty-1"),
  containerImageInspect: vi.fn(),
  containerImageHistory: vi.fn(async () => []),
  containerImagePull: vi.fn(async () => "pull-1"),
  containerImagePush: vi.fn(async () => "push-1"),
  containerImageRemove: vi.fn(async () => {}),
  containerImagePrune: vi.fn(async () => {}),
  containerImageTag: vi.fn(async () => {}),
  containerImageCommit: vi.fn(),
  containerRegistryLogin: vi.fn(async () => {}),
  onContainerStreamLine: vi.fn(),
  onContainerStreamEnd: vi.fn(),
}));

import ContainerDetailDrawer from "@/components/container/ContainerDetailDrawer.vue";
import { i18n } from "@/i18n";
import {
  containerInspect,
  containerLogsStart,
  containerStreamStop,
  onContainerStreamEnd,
  onContainerStreamLine,
} from "@/lib/backend/tauri";
import { useContainerStore } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerDetail, ContainerStreamEnd, ContainerStreamLine, ContainerSummary } from "@/types/container";

const inspectMock = vi.mocked(containerInspect);
const logsStartMock = vi.mocked(containerLogsStart);
const streamStopMock = vi.mocked(containerStreamStop);
const lineMock = vi.mocked(onContainerStreamLine);
const endMock = vi.mocked(onContainerStreamEnd);

let app: App | undefined;
let host: HTMLDivElement | undefined;
let lineListener: ((payload: ContainerStreamLine) => void) | null = null;
let endListener: ((payload: ContainerStreamEnd) => void) | null = null;

function target(): ContainerSummary {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "web",
    image: "nginx:latest",
    state: "running",
    status: "Up",
    ports: "8080:80/tcp",
    createdAt: "now",
  };
}

/** A second container, for the merged view's spec to pick as a guest. */
function guest(): ContainerSummary {
  return {
    id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    name: "api",
    image: "redis:7",
    state: "running",
    status: "Up",
    ports: "6379:6379/tcp",
    createdAt: "now",
  };
}

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-1",
    session: {
      id: "session-1",
      name: "lab engine",
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
      container: { runtime: "docker", transport: "local" },
      updatedAt: 0,
    },
    connectionId: null,
  };
}

function detail(): ContainerDetail {
  return {
    id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    name: "web",
    image: "nginx:latest",
    state: "running",
    status: "Up 2 hours",
    exitCode: 0,
    oomKilled: false,
    pid: 4242,
    restartPolicy: "always",
    entrypoint: "/docker-entrypoint.sh",
    command: "nginx -g 'daemon off;'",
    workDir: "/",
    user: "root",
    networkMode: "bridge",
    ip: "172.17.0.2",
    gateway: "172.17.0.1",
    ports: [{ hostPort: "8080", containerPort: "80", protocol: "tcp" }],
    mounts: [],
    env: ["PATH=/usr/bin"],
    raw: '{"Id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","Name":"/web"}',
  };
}

async function mount(mode: "detail" | "logs"): Promise<void> {
  const pinia = createPinia();
  setActivePinia(pinia);
  await useContainerStore().connect(tab());

  app = createApp({ render: () => h(ContainerDetailDrawer, { mode, tabId: "tab-1", target: target() }) });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

function button(label: string): HTMLButtonElement {
  const element = host
    ? [...host.querySelectorAll<HTMLButtonElement>("button")].find((entry) => entry.textContent?.trim() === label)
    : undefined;
  if (!element) {
    throw new Error(`there is no button called “${label}”`);
  }
  return element;
}

/** Types into the log search field the way a keyboard would, and lets the view answer it. */
async function typeInSearch(value: string): Promise<void> {
  const field = host?.querySelector<HTMLInputElement>("[data-logs-search]");
  if (!field) {
    throw new Error("the log view drew no search field");
  }
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
  await nextTick();
}

/** The clipboard a spec can read back, put where the drawer's copy actions look for it. */
function stubClipboard(): { writeText: ReturnType<typeof vi.fn>; written: () => string } {
  const written: string[] = [];
  const writeText = vi.fn(async (text: string) => {
    written.push(text);
  });
  Object.defineProperty(window.navigator, "clipboard", { value: { writeText }, configurable: true });
  return { writeText, written: () => written.join("\n") };
}

beforeEach(() => {
  lineListener = null;
  endListener = null;
  lineMock.mockImplementation(async (listener) => {
    lineListener = listener;
    return () => {};
  });
  endMock.mockImplementation(async (listener) => {
    endListener = listener;
    return () => {};
  });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.clearAllMocks();
});

describe("container detail drawer", () => {
  it("draws the fields of a container it read", async () => {
    inspectMock.mockResolvedValue(detail());
    await mount("detail");

    await vi.waitFor(() => {
      expect(host?.textContent).toContain("172.17.0.2");
    });
    expect(host?.textContent).toContain("nginx -g 'daemon off;'");
    expect(host?.textContent).toContain("8080:80");
  });

  it("reads the logs it opens and keeps the lines that arrived while paused", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");

    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledWith("conn-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", 500, false);
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }

    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z hello" });
    await nextTick();
    expect(host?.textContent).toContain("hello");

    button("Pause").click();
    await nextTick();
    lineListener({ streamId: "log-1", line: "while paused" });
    await nextTick();
    expect(host?.textContent).not.toContain("while paused");

    button("Resume").click();
    await nextTick();
    expect(host?.textContent).toContain("while paused");
  });

  it("stops the stream when it closes", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalled();
    });
    // Let the start answer land so the drawer holds the stream id.
    await vi.waitFor(() => {
      expect(host?.textContent).toContain("Nothing has been written yet.");
    });

    app?.unmount();
    app = undefined;
    await vi.waitFor(() => {
      expect(streamStopMock).toHaveBeenCalledWith("log-1");
    });
  });

  it("narrows the log to the lines that read as errors, and says when none do", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");

    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalled();
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z started" });
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:01Z connection refused by upstream" });
    await nextTick();
    await nextTick();

    const toggle = host?.querySelector<HTMLElement>("[data-logs-errors-only]");
    if (!toggle) {
      throw new Error("the log view offers no errors-only switch");
    }
    toggle.click();
    await nextTick();

    expect(host?.textContent).toContain("connection refused by upstream");
    expect(host?.textContent, "a line that says nothing went wrong is filtered out").not.toContain("started");
  });

  it("says so plainly when the error filter leaves nothing", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");

    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalled();
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z all is well" });
    await nextTick();

    host?.querySelector<HTMLElement>("[data-logs-errors-only]")?.click();
    await nextTick();

    expect(host?.querySelector("[data-logs-no-errors]")?.textContent).toContain("No line reads as an error.");
  });

  it("reopens the stream once the container it was following runs again", async () => {
    logsStartMock.mockResolvedValueOnce("log-1").mockResolvedValueOnce("log-2");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener || !endListener) {
      throw new Error("the drawer never subscribed to the stream");
    }

    // The container stopped — the engine ended the follow — and the list has caught up with that.
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z hello" });
    const store = useContainerStore();
    const session = store.sessionFor("tab-1");
    if (!session) {
      throw new Error("the drawer never connected its store");
    }
    session.containers = [{ ...target(), state: "exited" }];
    endListener({ streamId: "log-1", error: undefined });
    await nextTick();
    expect(host?.textContent).toContain("The stream has ended.");

    // The engine's event stream catches up: the container is running again, and the view reopens
    // the stream by itself — the second start is the reopen, with the waiting sentence drawn.
    session.containers = [{ ...target(), state: "running" }];
    await vi.waitFor(
      () => {
        expect(logsStartMock).toHaveBeenCalledTimes(2);
      },
      { timeout: 4_000 },
    );
    await vi.waitFor(() => {
      expect(host?.querySelector("[data-logs-reconnecting]")).toBeNull();
    });
    await nextTick();
    expect(host?.textContent).not.toContain("The stream has ended.");
  });

  it("stops reopening automatically when the stream cannot hold on, and leaves the manual button", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener || !endListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    const store = useContainerStore();
    const session = store.sessionFor("tab-1");
    if (!session) {
      throw new Error("the drawer never connected its store");
    }
    session.containers = [{ ...target(), state: "running" }];

    // Three reopens in a row, each ending without a single line: a stream that cannot hold on.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.waitFor(
        () => {
          expect(logsStartMock).toHaveBeenCalledTimes(attempt + 1);
        },
        { timeout: 4_000 },
      );
      endListener({ streamId: "log-1", error: undefined });
    }
    // The next end opens nothing: the person has the restart button that was always there.
    await new Promise((resolve) => setTimeout(resolve, 1_600));
    expect(logsStartMock).toHaveBeenCalledTimes(4);
    expect(host?.textContent).toContain("The stream has ended.");
  });
});

describe("the log view's search", () => {
  it("highlights every hit, counts them, and jumps between them without touching the stream", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z started" });
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:01Z error connecting" });
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:02Z connection error twice" });
    await nextTick();
    await nextTick();

    await typeInSearch("err");

    // Every hit is drawn as a mark of its own, and the count stands on the first of them.
    expect(host?.querySelectorAll("mark")).toHaveLength(2);
    expect(host?.querySelector("[data-logs-match-count]")?.textContent?.trim()).toBe("1 / 2");

    host?.querySelector<HTMLElement>("[data-logs-next]")?.click();
    await nextTick();
    expect(host?.querySelector("[data-logs-match-count]")?.textContent?.trim()).toBe("2 / 2");
    // The line the jump stands on is said out loud by the background it wears.
    expect(host?.querySelector('[data-log-line="2"]')?.className).toContain("bg-accent");

    // Stepping back from the first line wraps to the last.
    host?.querySelector<HTMLElement>("[data-logs-prev]")?.click();
    await nextTick();
    expect(host?.querySelector("[data-logs-match-count]")?.textContent?.trim()).toBe("1 / 2");

    // The search never reopens the stream: the one start the view made is still the only one.
    expect(logsStartMock).toHaveBeenCalledTimes(1);
  });

  it("keeps matching while the stream keeps arriving — the new lines join the highlights", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z error connecting" });
    await typeInSearch("err");
    expect(host?.querySelector("[data-logs-match-count]")?.textContent?.trim()).toBe("1 / 1");

    // A line that lands under a live search is matched the moment it is appended.
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:01Z another error lands" });
    await nextTick();
    await nextTick();

    expect(host?.querySelector("[data-logs-match-count]")?.textContent?.trim()).toBe("1 / 2");
    expect(host?.querySelectorAll("mark")).toHaveLength(2);
    expect(host?.textContent).toContain("another error lands");
    expect(logsStartMock, "a running search never resets the stream").toHaveBeenCalledTimes(1);
  });

  it("says a broken regex is broken, inline, and goes on matching once it is fixed", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z error connecting" });
    await nextTick();

    host?.querySelector<HTMLElement>("[data-logs-regex-toggle]")?.click();
    await nextTick();
    await typeInSearch("unclosed(");

    // The error is said beside the field, the view does not crash, and nothing is highlighted.
    expect(host?.querySelector("[data-logs-invalid-regex]")?.textContent).toContain("Invalid regular expression");
    expect(host?.querySelectorAll("mark")).toHaveLength(0);
    expect(host?.querySelector("[data-logs-match-count]")).toBeNull();

    await typeInSearch("err");
    expect(host?.querySelector("[data-logs-invalid-regex]")).toBeNull();
    expect(host?.querySelector("[data-logs-match-count]")?.textContent?.trim()).toBe("1 / 1");
    expect(logsStartMock, "the broken query never touched the stream").toHaveBeenCalledTimes(1);
  });
});

describe("the log view's merged streams", () => {
  it("prefixes every line with the container that wrote it, in a colour per source", async () => {
    logsStartMock.mockImplementation(async (_connection: string, containerId: string) =>
      containerId === guest().id ? "log-2" : "log-1",
    );
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener || !endListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    const store = useContainerStore();
    const session = store.sessionFor("tab-1");
    if (!session) {
      throw new Error("the drawer never connected its store");
    }
    session.containers = [target(), guest()];

    host?.querySelector<HTMLElement>("[data-logs-merge]")?.click();
    await vi.waitFor(() => {
      expect(logsStartMock, "the merge opens the anchor's own stream").toHaveBeenCalledTimes(2);
    });

    // The guest joins through the picker the merge button opened, one checkbox per candidate.
    const checkbox = host?.querySelector<HTMLInputElement>("[data-logs-merge-panel] input[type='checkbox']");
    if (!checkbox) {
      throw new Error("the merge panel drew no candidate checkbox");
    }
    checkbox.click();
    await vi.waitFor(() => {
      expect(logsStartMock, "the anchor's stream and the guest's stream both opened").toHaveBeenCalledTimes(4);
    });
    expect(logsStartMock).toHaveBeenCalledWith("conn-1", guest().id, 500, false);

    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z from the anchor" });
    lineListener({ streamId: "log-2", line: "2026-11-10T10:00:01Z from the guest" });
    await nextTick();
    await nextTick();

    // Every line says where it came from, and the two sources are told apart by colour.
    expect(host?.textContent).toContain("[web]");
    expect(host?.textContent).toContain("[api]");
    const anchorLine = host?.querySelector('[data-log-line="0"]');
    expect(anchorLine?.querySelector("span")?.getAttribute("style")).toContain("--log-source-1");
    expect(anchorLine?.querySelector("span")?.textContent?.trim()).toBe("[web]");
    const guestLine = host?.querySelector('[data-log-line="1"]');
    expect(guestLine?.querySelector("span")?.getAttribute("style")).toContain("--log-source-2");
    expect(guestLine?.querySelector("span")?.textContent?.trim()).toBe("[api]");

    // A stream that ends does not end the view: the guest's chip says so, the anchor keeps coming.
    endListener({ streamId: "log-2", error: undefined });
    await nextTick();
    expect(host?.querySelector("[data-logs-source-ended]")).not.toBeNull();

    // The prefixes can be turned off; the lines themselves stay.
    host?.querySelector<HTMLElement>("[data-logs-prefixes]")?.click();
    await nextTick();
    expect(host?.textContent).not.toContain("[web]");
    expect(host?.textContent).toContain("from the anchor");
  });

  it("copies and downloads exactly what the view is showing, filtered as it is", async () => {
    logsStartMock.mockResolvedValue("log-1");
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    const clipboard = stubClipboard();
    const downloaded: Blob[] = [];
    const names: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        downloaded.push(blob);
        return "blob:mock";
      }),
      configurable: true,
      writable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true, writable: true });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });

    lineListener({ streamId: "log-1", line: "first line" });
    lineListener({ streamId: "log-1", line: "2026-11-10T10:00:00Z error connecting" });
    lineListener({ streamId: "log-1", line: "a quiet line to hide" });
    await nextTick();

    host?.querySelector<HTMLElement>("[data-logs-errors-only]")?.click();
    await nextTick();

    host?.querySelector<HTMLElement>("[data-logs-copy-all]")?.click();
    await vi.waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalled();
    });
    const copied = clipboard.written();
    expect(copied).toContain("error connecting");
    expect(copied, "the copy is what the view shows, not the whole buffer").not.toContain("a quiet line to hide");

    host?.querySelector<HTMLElement>("[data-logs-download]")?.click();
    expect(downloaded).toHaveLength(1);
    const text = await downloaded[0]?.text();
    expect(text).toBe(copied);
    expect(names[0]).toMatch(/^web-\d{8}\.log$/);
  });

  it("copies the merged view with each line carrying its source, as it is drawn", async () => {
    logsStartMock.mockImplementation(async (_connection: string, containerId: string) =>
      containerId === guest().id ? "log-2" : "log-1",
    );
    await mount("logs");
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(1);
    });
    if (!lineListener) {
      throw new Error("the drawer never subscribed to the stream");
    }
    const clipboard = stubClipboard();
    const store = useContainerStore();
    const session = store.sessionFor("tab-1");
    if (!session) {
      throw new Error("the drawer never connected its store");
    }
    session.containers = [target(), guest()];

    host?.querySelector<HTMLElement>("[data-logs-merge]")?.click();
    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledTimes(2);
    });
    const checkbox = host?.querySelector<HTMLInputElement>("[data-logs-merge-panel] input[type='checkbox']");
    if (!checkbox) {
      throw new Error("the merge panel drew no candidate checkbox");
    }
    checkbox.click();
    await vi.waitFor(() => {
      expect(logsStartMock, "the anchor's stream and the guest's stream both opened").toHaveBeenCalledTimes(4);
    });
    lineListener({ streamId: "log-1", line: "from the anchor" });
    lineListener({ streamId: "log-2", line: "from the guest" });
    await nextTick();
    await nextTick();

    host?.querySelector<HTMLElement>("[data-logs-copy-all]")?.click();
    await vi.waitFor(() => {
      expect(clipboard.writeText).toHaveBeenCalled();
    });
    const copied = clipboard.written();
    expect(copied).toContain("[web] from the anchor");
    expect(copied).toContain("[api] from the guest");
  });
});
