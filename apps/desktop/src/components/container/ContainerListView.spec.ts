/**
 * The container list as a person meets it: which rows the default filter leaves, which row can be
 * entered, and what a destructive answer actually sends.
 *
 * The reason this is a component test rather than only a store one is the wiring the store cannot
 * see: the default "running only", an exec button that is disabled rather than failing, and the
 * confirmation whose answer is what carries `acknowledged` to the backend.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerConnect: vi.fn(async () => "conn-1"),
  containerDisconnect: vi.fn(async () => {}),
  containerList: vi.fn(async () => [
    {
      id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "web",
      image: "nginx:latest",
      state: "running",
      status: "Up",
      ports: "8080:80/tcp",
      createdAt: "now",
    },
    {
      id: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "old",
      image: "nginx:latest",
      state: "exited",
      status: "Exited (0)",
      ports: "",
      createdAt: "then",
    },
  ]),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(async () => null).mockRejectedValue(new Error("no info")),
  containerNamespaces: vi.fn(async () => []),
  containerSetNamespace: vi.fn(async () => {}),
  containerAction: vi.fn(async () => "done"),
  containerRename: vi.fn(async () => {}),
  containerCreate: vi.fn(async () => {}),
  containerInspect: vi.fn(),
  containerLogsStart: vi.fn(async () => "log-1"),
  containerStreamStop: vi.fn(async () => {}),
  containerExecOpen: vi.fn(async () => "pty-1"),
  filesOpenContainer: vi.fn(async () => ({
    kind: "opened",
    handle: "container-f1",
    sessionId: "session-1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    listing: { path: "/", entries: [] },
    packed: false,
  })),
  containerImageInspect: vi.fn(),
  containerImageHistory: vi.fn(async () => []),
  containerImagePull: vi.fn(async () => "pull-1"),
  containerImagePush: vi.fn(async () => "push-1"),
  containerImageRemove: vi.fn(async () => {}),
  containerImagePrune: vi.fn(async () => {}),
  containerImageTag: vi.fn(async () => {}),
  containerImageCommit: vi.fn(),
  containerRegistryLogin: vi.fn(async () => {}),
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

import ContainerListView from "@/components/container/ContainerListView.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { i18n } from "@/i18n";
import { containerAction, containerExecOpen, filesOpenContainer } from "@/lib/backend/tauri";
import { useContainerStore, type ContainerSession } from "@/stores/container";
import { useTerminalsStore, type ContainerTab } from "@/stores/terminals";
import type { ContainerActionOutcome } from "@/types/container";

const actionMock = vi.mocked(containerAction);
const execMock = vi.mocked(containerExecOpen);
const filesMock = vi.mocked(filesOpenContainer);

let app: App | undefined;
let host: HTMLDivElement | undefined;

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

/** Opens the store's session for the tab and mounts the list over it. */
async function mount(handlers: Record<string, unknown> = {}): Promise<ContainerSession> {
  const engine = tab();
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useContainerStore();
  await store.connect(engine);
  const session = store.sessionFor(engine.id);
  if (!session) {
    throw new Error("the session was never opened");
  }

  app = createApp({
    render: () => h(ContainerListView, { tab: engine, session, imageFilter: null, stateFilter: null, ...handlers }),
  });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
  return session;
}

function rows(): HTMLTableRowElement[] {
  return [...(host?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])];
}

function button(label: string): HTMLButtonElement {
  const element = host?.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (!element) {
    throw new Error(`there is no button called “${label}”`);
  }
  return element;
}

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.clearAllMocks();
});

beforeEach(() => {
  actionMock.mockResolvedValue("done");
  execMock.mockResolvedValue("pty-1");
  filesMock.mockClear();
});

describe("container list", () => {
  it("leaves room between the first column and the pane edge", async () => {
    await mount();
    const table = host?.querySelector("table");
    expect(table?.parentElement?.className).toContain("px-3");
  });

  it("shows running containers by default and all of them once the filter is off", async () => {
    await mount();
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain("web");

    const runningOnly = host?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    if (!runningOnly) {
      throw new Error("the running-only filter is not on the toolbar");
    }
    runningOnly.click();
    await nextTick();

    expect(rows()).toHaveLength(2);
  });

  it("will not offer a shell in a container that is not running", async () => {
    await mount();
    const runningOnly = host?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    runningOnly?.click();
    await nextTick();

    expect(button("Open a shell in old").disabled).toBe(true);
    expect(button("Open a shell in web").disabled).toBe(false);
  });

  /**
   * A stopped container has no file system to list, so the action says so by being unavailable —
   * the same rule the shell button follows, for the same reason: a click that can only fail is
   * worse than a button that is visibly not offered.
   */
  it("offers a container's files only while the container is running", async () => {
    await mount();
    const runningOnly = host?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    runningOnly?.click();
    await nextTick();

    expect(button("Browse the files of web").disabled).toBe(false);
    expect(button("Browse the files of old").disabled).toBe(true);
  });

  it("opens a container's files through the engine the workspace already holds", async () => {
    await mount();

    button("Browse the files of web").click();

    await vi.waitFor(() => {
      expect(filesMock).toHaveBeenCalledWith("conn-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "/");
    });
    await vi.waitFor(() => {
      const terminals = useTerminalsStore();
      expect(terminals.tabs.some((entry) => entry.kind === "files" && entry.handle === "container-f1")).toBe(true);
    });
  });

  it("opens a shell as an ordinary terminal tab on the handle the backend made", async () => {
    await mount();

    button("Open a shell in web").click();
    await vi.waitFor(() => {
      expect(execMock).toHaveBeenCalledWith("conn-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "sh");
    });
    await vi.waitFor(() => {
      const terminals = useTerminalsStore();
      expect(terminals.tabs.some((entry) => entry.kind === "terminal" && entry.handle === "pty-1")).toBe(true);
    });
  });

  it("asks before stopping and sends the answer as the acknowledgement", async () => {
    await mount();

    button("Stop web").click();
    await vi.waitFor(() => {
      expect(document.body.textContent).toContain("Stop the container “web”?");
    });

    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === "Stop",
    );
    if (!confirm) {
      throw new Error("the confirmation has no Stop button");
    }
    confirm.click();

    await vi.waitFor(() => {
      expect(actionMock).toHaveBeenCalledWith("conn-1", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "stop", true);
    });
  });
});

describe("the desktop layout of the same list", () => {
  /** Mounts the list in the desktop window's layout, over the same session the flat table uses. */
  async function mountDesktop(handlers: Record<string, unknown> = {}): Promise<ContainerSession> {
    const engine = tab();
    const pinia = createPinia();
    setActivePinia(pinia);
    const store = useContainerStore();
    await store.connect(engine);
    const session = store.sessionFor(engine.id);
    if (!session) {
      throw new Error("the session was never opened");
    }

    app = createApp({
      render: () =>
        h(ContainerListView, {
          tab: engine,
          session,
          layout: "desktop",
          imageFilter: null,
          stateFilter: null,
          ...handlers,
        }),
    });
    app.use(i18n);
    app.use(pinia);
    host = document.createElement("div");
    document.body.append(host);
    app.mount(host);
    await nextTick();
    return session;
  }

  function rowOf(name: string): HTMLTableRowElement | undefined {
    return [...(host?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])].find((row) =>
      row.textContent?.includes(name),
    );
  }

  /** Opens the row's one menu — the ellipsis at the actions' end, past the buttons on the row. */
  async function openRowMenu(name: string): Promise<void> {
    const more = rowOf(name)?.querySelector<HTMLButtonElement>(`button[aria-label="More actions for ${name}"]`);
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
  }

  /** Turns the default "running only" off, so the exited container's row is drawn too. */
  async function showEveryState(): Promise<void> {
    const checkbox = host?.querySelector<HTMLInputElement>('input[type="checkbox"]');
    checkbox?.click();
    await nextTick();
  }

  /** Runs the one entry of the open menu whose id is given, the way a click on its row would. */
  async function runMenuEntry(id: string): Promise<void> {
    const menu = useContextMenu();
    const entry = menu.entries.value.find((candidate) => candidate.kind === "action" && candidate.id === id);
    if (entry === undefined || entry.kind !== "action") {
      throw new Error(`the menu has no action called ${id}`);
    }
    await entry.run();
  }

  it("draws the state as the light-wash tag the state table names", async () => {
    await mountDesktop();
    await showEveryState();

    const running = rowOf("web")?.querySelector("[data-wb-tag]");
    const exited = rowOf("old")?.querySelector("[data-wb-tag]");
    expect(running?.textContent?.trim()).toBe("Running");
    expect(running?.className).toContain("wb-tag--success");
    expect(exited?.textContent?.trim()).toBe("Exited");
    expect(exited?.className).toContain("wb-tag--neutral");
  });

  it("draws the healthcheck verdict beside the state, and nothing when the engine said none", async () => {
    const session = await mountDesktop();
    expect(rowOf("web")?.querySelector("[data-container-health-badge]"), "no healthcheck, no badge").toBeNull();

    // The engine's verdicts arrive with the list row, in the engine's own words.
    const web = session.containers[0];
    const old = session.containers[1];
    if (!web || !old) {
      throw new Error("the list never arrived");
    }
    session.containers = [
      { ...web, health: "healthy" },
      { ...old, state: "running", health: "unhealthy" },
    ];
    await nextTick();
    await showEveryState();

    const badges = [...(host?.querySelectorAll<HTMLElement>("[data-container-health-badge]") ?? [])];
    expect(badges).toHaveLength(2);
    expect(badges[0]?.textContent?.trim()).toBe("Healthy");
    expect(badges[0]?.className).toContain("wb-tag--success");
    expect(badges[1]?.textContent?.trim()).toBe("Unhealthy");
    expect(badges[1]?.className).toContain("wb-tag--danger");
  });

  it("keeps the flat table's row untouched when no layout is asked for", async () => {
    await mount();

    const row = rowOf("web");
    expect(row?.querySelector("[data-wb-tag]"), "the flat row has no tag").toBeNull();
    expect(row?.querySelectorAll("button")?.length).toBeGreaterThan(1);
  });

  it("carries the row's frequent actions as visible buttons, and gathers the rest under the one menu", async () => {
    await mountDesktop();
    await showEveryState();

    // The actions a row needs at a glance sit on the row itself: the exited container offers
    // start, the running one stop, and shell, logs and files stand beside either.
    expect(button("Start old").disabled).toBe(false);
    expect(button("Open a shell in old").disabled, "a stopped container's shell is disabled, not hidden").toBe(true);
    expect(rowOf("web")?.querySelector('button[aria-label="Stop web"]')).not.toBeNull();
    expect(rowOf("web")?.querySelector('button[aria-label="Start web"]'), "no start beside a stop").toBeNull();

    // The rest gathers under the one menu, and the engine's word labels them.
    const menu = useContextMenu();
    await openRowMenu("old");
    expect(menu.visible.value).toBe(true);
    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : entry.kind));
    expect(ids).toContain("monitor");
    expect(ids).toContain("clone");
    expect(ids).toContain("remove");
  });

  it("says what a write in flight is doing, on the row it is working on", async () => {
    let settle: ((value: ContainerActionOutcome) => void) | undefined;
    actionMock.mockImplementation(
      () =>
        new Promise<ContainerActionOutcome>((resolve) => {
          settle = resolve;
        }),
    );
    await mountDesktop();
    await showEveryState();

    // Start is a button on the exited row itself now; the click is the row's own.
    button("Start old").click();
    await nextTick();

    const loading = rowOf("old")?.querySelector("[data-container-row-loading]");
    expect(loading?.textContent?.trim()).toBe("Starting…");

    settle?.("done");
    await vi.waitFor(() => {
      expect(rowOf("old")?.querySelector("[data-container-row-loading]")).toBeNull();
    });
  });

  it("states the consequence of removal in the confirmation it sends acknowledged", async () => {
    await mountDesktop();
    await showEveryState();

    await openRowMenu("old");
    await runMenuEntry("remove");
    await nextTick();

    expect(document.body.textContent).toContain("Remove the container “old”?");
    expect(document.body.textContent).toContain("All data inside the container will be lost.");

    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (element) => element.textContent?.trim() === "Remove",
    );
    confirm?.click();
    await vi.waitFor(() => {
      expect(actionMock).toHaveBeenCalledWith("conn-1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "rm", true);
    });
  });

  it("offers the clone ask under the row's menu, and hands the row itself with it", async () => {
    const clones: Array<{ id: string; name: string }> = [];
    const session = await mountDesktop({
      onClone: (container: { id: string; name: string }) => clones.push(container),
    });

    const row = session.containers.find((container) => container.state === "running");
    if (row === undefined) {
      throw new Error("the harness seeded no running container");
    }
    await openRowMenu(row.name);
    await runMenuEntry("clone");

    expect(clones, "the pane receives the container it is meant to inspect and pre-fill from").toHaveLength(1);
    expect(clones[0]?.id).toBe(row.id);
    expect(clones[0]?.name).toBe(row.name);
  });

  it("offers the monitor ask on a running row, and hands the row with it", async () => {
    const monitored: Array<{ id: string; name: string }> = [];
    const session = await mountDesktop({
      onMonitor: (container: { id: string; name: string }) => monitored.push(container),
    });

    const row = session.containers.find((container) => container.state === "running");
    if (row === undefined) {
      throw new Error("the harness seeded no running container");
    }
    await openRowMenu(row.name);
    await runMenuEntry("monitor");

    expect(monitored, "the pane opens the charts over the row that asked").toHaveLength(1);
    expect(monitored[0]?.id).toBe(row.id);
  });
});
