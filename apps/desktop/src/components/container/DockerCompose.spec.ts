/**
 * The desktop Compose page, as a person uses it: the project list with its folded counts, the
 * wizard that writes the file and starts the project, the verbs that keep the workspace's gate,
 * the YAML editor with its diff and its rebuild gate, the export that hands the file back, and
 * the log window on the shared stream channel.
 *
 * What is checked is what a wrongly wired page would do — read again without a hand on the
 * refresh, send a file the form had marked invalid, start a project before the file was written,
 * apply a rebuild nobody acknowledged, or leave a stream running after its window closed.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  composeLs: vi.fn(async () => []),
  composeUp: vi.fn(async () => null),
  composeDown: vi.fn(async () => {}),
  composeRestart: vi.fn(async () => {}),
  composeLogsStart: vi.fn(async () => "log-1"),
  composeWriteYaml: vi.fn(async () => {}),
  containerStreamStop: vi.fn(async () => {}),
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
  filesOpen: vi.fn(async () => ({
    kind: "opened",
    handle: "f-1",
    sessionId: "s",
    listing: { path: "/", entries: [] },
    packed: false,
  })),
  filesReadText: vi.fn(async () => ""),
  filesClose: vi.fn(async () => {}),
}));

import DockerCompose from "@/components/container/DockerCompose.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { i18n } from "@/i18n";
import {
  composeDown,
  composeLs,
  composeLogsStart,
  composeRestart,
  composeUp,
  composeWriteYaml,
  containerStreamStop,
  filesClose,
  filesOpen,
  filesReadText,
  onContainerStreamLine,
} from "@/lib/backend/tauri";
import type { ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { ComposeProject } from "@/types/container";

const listMock = vi.mocked(composeLs);
const upMock = vi.mocked(composeUp);
const downMock = vi.mocked(composeDown);
const restartMock = vi.mocked(composeRestart);
const logsStartMock = vi.mocked(composeLogsStart);
const writeYamlMock = vi.mocked(composeWriteYaml);
const streamStopMock = vi.mocked(containerStreamStop);
const filesOpenMock = vi.mocked(filesOpen);
const readTextMock = vi.mocked(filesReadText);
const filesCloseMock = vi.mocked(filesClose);

/** The stream listener the page registers; the spec feeds it lines the way the backend would. */
let streamListener: ((payload: { streamId: string; line: string }) => void) | null = null;

const WEB_YML = "services:\n  web:\n    image: nginx:1.25\n";
const WEB: ComposeProject = {
  name: "web-app",
  status: "running(2)",
  configFiles: "/opt/compose/web-app/docker-compose.yml",
  services: 3,
  containers: 4,
};
const DB: ComposeProject = {
  name: "mem-compose-test",
  status: "exited(1)",
  configFiles: "/opt/compose/mem-compose-test/docker-compose.yml",
  services: 1,
  containers: 1,
};

let app: App | undefined;
let host: HTMLDivElement | undefined;
/** The running counts the page handed up; the rail's badge draws the last one. */
const runningCounts: (number | null)[] = [];

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-compose",
    session: {
      id: "session-compose",
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
    connectionId: "conn-1",
  };
}

function session(): ContainerSession {
  return {
    connectionId: "conn-1",
    runtime: "docker",
    namespace: "default",
    containers: [],
    images: [],
    namespaces: [],
    loading: false,
    refreshing: false,
    imagesLoading: false,
    error: null,
    info: null,
    tasks: [],
    eventsStreamId: null,
  };
}

async function mount(): Promise<void> {
  const engine = tab();
  const pinia = createPinia();
  setActivePinia(pinia);
  runningCounts.length = 0;
  app = createApp({
    render: () =>
      h(DockerCompose, {
        tab: engine,
        session: session(),
        onRunningCount: (count: number | null) => runningCounts.push(count),
      }),
  });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

function rows(): HTMLTableRowElement[] {
  return [...(host?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])];
}

function body(): string {
  return document.body.textContent ?? "";
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

function fill(selector: string, value: string): void {
  const field = document.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-compose-${selector}]`);
  if (!field) {
    throw new Error(`the compose page drew no ${selector} field`);
  }
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

async function openCreate(): Promise<void> {
  (document.querySelector("[data-compose-create]") as HTMLElement)?.click();
  await settle();
}

/** The row's menu entry, run the way the composable's consumers do. */
async function runMenuEntry(projectName: string, id: string): Promise<void> {
  const menu = useContextMenu();
  const more = rows()
    .find((row) => row.textContent?.includes(projectName))
    ?.querySelector("button");
  more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
  const entry = menu.entries.value.find((item) => item.kind === "action" && item.id === id);
  if (entry === undefined || entry.kind !== "action") {
    throw new Error(`the menu has no ${id} action`);
  }
  entry.run();
  menu.closeMenu();
  await settle();
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([WEB, DB]);
  upMock.mockReset().mockResolvedValue(null);
  downMock.mockReset().mockResolvedValue(undefined);
  restartMock.mockReset().mockResolvedValue(undefined);
  logsStartMock.mockReset().mockResolvedValue("log-1");
  writeYamlMock.mockReset().mockResolvedValue(undefined);
  streamStopMock.mockReset().mockResolvedValue(undefined);
  filesOpenMock.mockReset().mockResolvedValue({
    kind: "opened",
    handle: "f-1",
    sessionId: "session-compose",
    listing: { path: "/", entries: [] },
    packed: false,
  });
  readTextMock.mockReset().mockResolvedValue(WEB_YML);
  filesCloseMock.mockReset().mockResolvedValue(undefined);
  window.localStorage.clear();
  window.innerWidth = 1280;
  streamListener = null;
  vi.mocked(onContainerStreamLine)
    .mockClear()
    .mockImplementation(async (listener) => {
      streamListener = listener;
      return () => {};
    });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the project list", () => {
  it("draws one row per project: name, status tag, the folded service and container counts", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    const web = rows().find((row) => row.textContent?.includes("web-app"));
    expect(web?.querySelector("[data-compose-status]")?.textContent?.trim()).toBe("running(2)");
    expect(web?.querySelector("[data-compose-status]")?.className).toContain("wb-tag--success");
    expect(web?.querySelector("[data-compose-services]")?.textContent?.trim()).toBe("3");
    expect(web?.querySelector("[data-compose-containers]")?.textContent?.trim()).toBe("4");

    const db = rows().find((row) => row.textContent?.includes("mem-compose-test"));
    expect(db?.querySelector("[data-compose-status]")?.className).toContain("wb-tag--neutral");
  });

  it("is read once when the page opens and again only when the refresh is pressed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(listMock, "no polling").toHaveBeenCalledTimes(1);

    (document.querySelector("[data-compose-refresh]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("says so when the engine has no projects", async () => {
    listMock.mockResolvedValue([]);
    await mount();
    await vi.waitFor(() => {
      expect(body()).toContain("No Compose projects");
    });
  });

  it("narrows to the names the filter carries", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    fill("filter", "mem-compose");
    await settle();
    expect(rows().filter((row) => row.textContent?.includes("mem-compose-test"))).toHaveLength(1);
    expect(rows()).toHaveLength(1);
  });
});

describe("the create wizard", () => {
  it("checks the name and the file while they are typed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await openCreate();

    fill("name", "My-App");
    await settle();
    expect(body()).toContain("must start with a letter or digit");

    fill("name", "my-app");
    fill("yml", "services:\n  web:\n\timage: nginx");
    await settle();
    expect(body()).toContain("Line 3 indents with a tab");

    fill("yml", "services:\n  web:\n    image: nginx\n ports: []");
    await settle();
    expect(body()).toContain("Line 4 returns to an indentation");

    fill("yml", "services:\n  web:\n    image: nginx:latest");
    await settle();
    expect(body()).not.toContain("Line");
  });

  it("writes the file first, then starts the project detached from it, and reads the list again", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await openCreate();

    fill("name", "mem-compose-test");
    fill("directory", "/opt/compose/mem-compose-test");
    fill("yml", "services:\n  web:\n    image: nginx:latest");
    await settle();

    (document.querySelector("[data-compose-submit]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(writeYamlMock).toHaveBeenCalledWith(
        "conn-1",
        "/opt/compose/mem-compose-test/docker-compose.yml",
        "services:\n  web:\n    image: nginx:latest",
      );
    });
    await vi.waitFor(() => {
      expect(upMock).toHaveBeenCalledWith(
        "conn-1",
        "mem-compose-test",
        "/opt/compose/mem-compose-test/docker-compose.yml",
        true,
      );
    });
    // The list comes back fresh once the engine has taken the file.
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("holds the step while the form is incomplete", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await openCreate();
    await settle();

    const submit = document.querySelector("[data-compose-submit]") as HTMLButtonElement;
    expect(submit?.hasAttribute("disabled"), "an empty form does not travel").toBe(true);
    expect(writeYamlMock).not.toHaveBeenCalled();
    expect(upMock).not.toHaveBeenCalled();
  });
});

describe("the project's verbs", () => {
  it("restarts only through the gate, and names what restarting ends", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("web-app", "restart");

    expect(restartMock).not.toHaveBeenCalled();
    expect(body()).toContain("Restart the project “web-app”?");
    expect(body()).toContain("stopped and started again");

    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Restart");
    (confirm as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(restartMock).toHaveBeenCalledWith("conn-1", "web-app");
    });
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("brings a project down behind the gate that says its containers stop and are removed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("mem-compose-test", "down");

    expect(downMock).not.toHaveBeenCalled();
    expect(body()).toContain("Bring down the project “mem-compose-test”?");
    expect(body()).toContain("will stop and be removed");

    const confirm = [...document.querySelectorAll("button")].find(
      (button) => button.textContent?.trim() === "Bring down",
    );
    (confirm as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(downMock).toHaveBeenCalledWith("conn-1", "mem-compose-test");
    });
  });

  it("offers starting only to a stopped project whose file the engine named", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    // web-app is already running: no start in its menu.
    const menu = useContextMenu();
    const more = rows()
      .find((row) => row.textContent?.includes("web-app"))
      ?.querySelector("button");
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    expect(menu.entries.value.find((item) => item.kind === "action" && item.id === "up")).toBeUndefined();
    menu.closeMenu();
    await nextTick();

    // The stopped project has a file on record: starting it reads that file, detached.
    await runMenuEntry("mem-compose-test", "up");
    expect(body()).toContain("Start the project “mem-compose-test”?");
    const confirm = [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Start");
    (confirm as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(upMock).toHaveBeenCalledWith(
        "conn-1",
        "mem-compose-test",
        "/opt/compose/mem-compose-test/docker-compose.yml",
        true,
      );
    });
  });
});

describe("the log window", () => {
  it("follows the project's logs on the shared stream, and stops the stream when it closes", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("web-app", "logs");

    await vi.waitFor(() => {
      expect(logsStartMock).toHaveBeenCalledWith("conn-1", "web-app", 500);
    });
    await vi.waitFor(() => {
      expect(streamListener, "the page is listening on the shared channel").not.toBeNull();
    });

    streamListener?.({ streamId: "log-1", line: "web-app-1 | listening on 80" });
    await settle();
    expect(body()).toContain("listening on 80");

    // A line for another window's stream reaches nothing here.
    streamListener?.({ streamId: "log-2", line: "not this window" });
    await settle();
    expect(body()).not.toContain("not this window");

    const close = document.querySelector('[role="dialog"] [aria-label="Close"]') as HTMLElement | null;
    if (!close) {
      const title = [...document.querySelectorAll('[role="dialog"] button')].at(-1);
      throw new Error(`the log window drew no close button: ${title?.textContent}`);
    }
    close.click();
    await vi.waitFor(() => {
      expect(streamStopMock).toHaveBeenCalledWith("log-1");
    });
  });

  it("keeps what arrives while it is paused, and hands it back when it resumes", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("web-app", "logs");
    await vi.waitFor(() => {
      expect(streamListener).not.toBeNull();
    });

    (document.querySelector("[data-compose-logs-pause]") as HTMLElement)?.click();
    await settle();
    streamListener?.({ streamId: "log-1", line: "kept while paused" });
    await settle();
    expect(body(), "the paused window does not show it yet").not.toContain("kept while paused");

    (document.querySelector("[data-compose-logs-pause]") as HTMLElement)?.click();
    await settle();
    expect(body()).toContain("kept while paused");
  });

  it("narrows to the service the filter names, colours the prefixes apart, and lets the lot back", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("web-app", "logs");
    await vi.waitFor(() => {
      expect(streamListener).not.toBeNull();
    });

    streamListener?.({ streamId: "log-1", line: "web-app-web-1 | listening on 80" });
    streamListener?.({ streamId: "log-1", line: "web-app-db-1 | db ready" });
    streamListener?.({ streamId: "log-1", line: "web-app-web-1 | second line from web" });
    await settle();

    // The prefix wears the service's colour, and the two services are told apart by it.
    const webLine = document.querySelector('[data-compose-logs-prefix="web-app-web-1"]');
    const dbLine = document.querySelector('[data-compose-logs-prefix="web-app-db-1"]');
    expect(webLine?.getAttribute("style")).toContain("--log-source");
    expect(dbLine?.getAttribute("style")).toContain("--log-source");
    expect(webLine?.getAttribute("style")).not.toBe(dbLine?.getAttribute("style"));

    // The filter is the page's own dropdown; picking "web" leaves only its lines.
    await openServiceFilter();
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.trim() === "web",
    );
    if (!option) {
      const seen = [...document.querySelectorAll<HTMLElement>('[role="option"]')].map((candidate) =>
        candidate.textContent?.trim(),
      );
      throw new Error(`the filter has no web entry; it offered ${seen.join(", ")}`);
    }
    option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    await settle();

    expect(body()).toContain("listening on 80");
    expect(body()).toContain("second line from web");
    expect(body(), "another service's lines are not drawn").not.toContain("db ready");

    // A service the buffer has heard of but a clear has emptied is said so, not drawn as blank.
    streamListener?.({ streamId: "log-1", line: "web-app-idle-1 | passing through" });
    await settle();
    await openServiceFilter();
    const idleOption = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.trim() === "idle",
    );
    if (!idleOption) {
      throw new Error("the filter has no idle entry");
    }
    idleOption.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    await settle();
    expect(body()).toContain("passing through");

    const clearButton = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (candidate) => candidate.textContent?.trim() === "Clear",
    );
    if (!clearButton) {
      throw new Error("the log window drew no clear button");
    }
    clearButton.click();
    await settle();
    expect(document.querySelector("[data-compose-logs-service-empty]")?.textContent).toContain(
      "No line comes from this service yet.",
    );

    // "All services" is the way back.
    await openServiceFilter();
    const all = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
      (candidate) => candidate.textContent?.trim() === "All services",
    );
    if (!all) {
      throw new Error("the filter has no all-services entry");
    }
    all.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    await settle();
    expect(body(), "the cleared buffer is empty for every service").not.toContain("db ready");
    expect(body()).not.toContain("listening on 80");
  });
});

/**
 * Opens the service filter, which is the interface's own control: its list is teleported to the
 * body and reka-ui opens it on a pointer going down rather than on a click.
 */
async function openServiceFilter(): Promise<void> {
  const trigger = document.querySelector<HTMLElement>("[data-compose-logs-service]");
  if (!trigger) {
    throw new Error("the log window drew no service filter");
  }
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  trigger.click();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("the rail's badge", () => {
  it("hands up the running count the list reads, and nothing when the read fails", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(runningCounts).toEqual([1]);
    });

    (document.querySelector("[data-compose-refresh]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(runningCounts).toEqual([1, 1]);
    });

    listMock.mockRejectedValueOnce(new Error("the engine went away"));
    (document.querySelector("[data-compose-refresh]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(runningCounts.at(-1)).toBeNull();
    });
  });
});

describe("the columns the table draws", () => {
  it("keeps every column wide, and trims the two counts the window makes narrow", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    expect(document.querySelector("[data-compose-services]")).not.toBeNull();

    window.innerWidth = 800;
    window.dispatchEvent(new Event("resize"));
    await settle();
    expect(document.querySelector("[data-compose-services]"), "the narrow window trims the counts").toBeNull();
    expect(document.querySelector("[data-compose-containers]")).toBeNull();
    // The rows keep their name, state and actions: the list is still a list.
    expect(rows()[0]?.textContent).toContain("web-app");

    // The way back is the choice, not the width: the toolbar's columns menu.
    const menu = useContextMenu();
    (document.querySelector("[data-compose-columns]") as HTMLElement)?.click();
    await nextTick();
    const entry = menu.entries.value.find((item) => item.kind === "action" && item.id === "column-services");
    if (entry === undefined || entry.kind !== "action") {
      throw new Error("the columns menu has no services entry");
    }
    entry.run();
    menu.closeMenu();
    await settle();
    expect(document.querySelector("[data-compose-services]"), "the explicit choice wins over the width").not.toBeNull();
    expect(window.localStorage.getItem("container:listColumns.compose")).toContain('"services":"shown"');
  });

  it("reads a choice from the storage back across a mount", async () => {
    window.localStorage.setItem(
      "container:listColumns.compose",
      JSON.stringify({ services: "hidden", containers: "hidden" }),
    );
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    expect(document.querySelector("[data-compose-services]")).toBeNull();
    expect(document.querySelector("[data-compose-containers]")).toBeNull();
    // A hidden column's header is gone with it, so the way back is the toolbar's columns menu.
    const menu = useContextMenu();
    (document.querySelector("[data-compose-columns]") as HTMLElement)?.click();
    await nextTick();
    const restore = menu.entries.value.find((item) => item.kind === "action" && item.id === "column-services");
    if (restore === undefined || restore.kind !== "action") {
      throw new Error("the column menu has no services entry");
    }
    restore.run();
    menu.closeMenu();
    await settle();
    expect(document.querySelector("[data-compose-services]")).not.toBeNull();
  });
});

describe("the project's YAML editor", () => {
  async function openEditor(projectName: string): Promise<void> {
    await runMenuEntry(projectName, "edit");
    await vi.waitFor(() => {
      expect(document.querySelector("[data-compose-edit-yml]")).not.toBeNull();
    });
  }

  function editorField(): HTMLTextAreaElement {
    const field = document.querySelector<HTMLTextAreaElement>("[data-compose-edit-yml]");
    if (!field) {
      throw new Error("the editor drew no text area");
    }
    return field;
  }

  it("reads the file through the session's file channel, opened and closed for the one read", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await openEditor("web-app");

    expect(filesOpenMock).toHaveBeenCalledWith("session-compose");
    expect(readTextMock).toHaveBeenCalledWith("f-1", "/opt/compose/web-app/docker-compose.yml");
    await vi.waitFor(() => {
      expect(filesCloseMock).toHaveBeenCalledWith("f-1");
    });
    expect(editorField().value).toBe(WEB_YML);
    expect(document.querySelector("[data-compose-edit-unchanged]")).not.toBeNull();
  });

  it("shows the save as a line diff before anything is written", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await openEditor("web-app");

    fill("edit-yml", "services:\n  web:\n    image: nginx:1.27\n");
    await settle();

    const preview = document.querySelector("[data-compose-edit-diff]");
    expect(preview?.textContent).toContain("+");
    expect(preview?.textContent).toContain("nginx:1.27");
    expect(document.body.textContent).toContain("nginx:1.25");
    expect(writeYamlMock).not.toHaveBeenCalled();
  });

  it("saves the file alone when only the write is asked for", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await openEditor("web-app");
    fill("edit-yml", "services:\n  web:\n    image: nginx:1.27\n");
    await settle();

    (document.querySelector("[data-compose-edit-save]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(writeYamlMock).toHaveBeenCalledWith(
        "conn-1",
        "/opt/compose/web-app/docker-compose.yml",
        "services:\n  web:\n    image: nginx:1.27\n",
      );
    });
    expect(upMock, "a save alone never rebuilds").not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("gates the apply behind the acknowledgment that a rebuild restarts the services", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await openEditor("web-app");
    fill("edit-yml", "services:\n  web:\n    image: nginx:1.27\n");
    await settle();

    (document.querySelector("[data-compose-edit-apply]") as HTMLElement)?.click();
    await settle();
    expect(document.body.textContent).toContain("restarts the services");
    expect(document.querySelector("[data-compose-rebuild-ack]")).not.toBeNull();

    // The confirm without the acknowledgment is not an answer: nothing travels. The confirm
    // dialog is drawn after the editor's own footer, so its button is the last one to say so.
    const confirm = [...document.querySelectorAll("button")]
      .filter((button) => button.textContent?.trim() === "Save and apply")
      .at(-1);
    (confirm as HTMLElement)?.click();
    await settle();
    expect(writeYamlMock).not.toHaveBeenCalled();
    expect(upMock).not.toHaveBeenCalled();
    expect(document.querySelector("[data-compose-rebuild-refused]")).not.toBeNull();

    // The acknowledgment given, the file goes first and the project comes up detached.
    const ack = document.querySelector<HTMLInputElement>("[data-compose-rebuild-ack] input");
    if (!ack) {
      throw new Error("the rebuild prompt drew no acknowledgment");
    }
    ack.checked = true;
    ack.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();
    (confirm as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(writeYamlMock).toHaveBeenCalledWith(
        "conn-1",
        "/opt/compose/web-app/docker-compose.yml",
        "services:\n  web:\n    image: nginx:1.27\n",
      );
      expect(upMock).toHaveBeenCalledWith("conn-1", "web-app", "/opt/compose/web-app/docker-compose.yml", true);
    });
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("holds both buttons while the edited text would not survive the engine's reading", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await openEditor("web-app");
    fill("edit-yml", "services:\n  web:\n\timage: nginx\n");
    await settle();

    expect(document.body.textContent).toContain("indents with a tab");
    const save = document.querySelector<HTMLButtonElement>("[data-compose-edit-save]");
    const apply = document.querySelector<HTMLButtonElement>("[data-compose-edit-apply]");
    expect(save?.hasAttribute("disabled")).toBe(true);
    expect(apply?.hasAttribute("disabled")).toBe(true);
    expect(writeYamlMock).not.toHaveBeenCalled();
  });

  it("says so when the file channel stands in front of the read", async () => {
    filesOpenMock.mockResolvedValue({
      kind: "hostKeyUnknown",
      key: { host: "engine", port: 22, keyType: "ed25519", publicKey: "AAAATEST", fingerprint: "SHA256:abc" },
    });
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("web-app", "edit");
    await settle();
    expect(document.querySelector("[data-compose-edit-failure]")?.textContent).toContain("file channel");
  });
});

describe("the orchestration export", () => {
  it("hands the project's file back as a download named for the project", async () => {
    const downloaded: Blob[] = [];
    const names: string[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      value: vi.fn((blob: Blob) => {
        downloaded.push(blob);
        return "blob:export";
      }),
      configurable: true,
    });
    Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), configurable: true });
    const anchorClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function click(this: HTMLAnchorElement) {
      names.push(this.download);
    };

    try {
      await mount();
      await vi.waitFor(() => {
        expect(rows().length).toBe(2);
      });
      await runMenuEntry("web-app", "export");

      await vi.waitFor(() => {
        expect(downloaded).toHaveLength(1);
      });
      expect(names).toEqual(["web-app.compose.yml"]);
      expect(await downloaded[0]?.text()).toBe(WEB_YML);
      expect(readTextMock).toHaveBeenCalledWith("f-1", "/opt/compose/web-app/docker-compose.yml");
      expect(writeYamlMock, "an export never writes").not.toHaveBeenCalled();
      expect(upMock, "an export never starts anything").not.toHaveBeenCalled();
    } finally {
      HTMLAnchorElement.prototype.click = anchorClick;
    }
  });

  it("says so when the file channel would not open", async () => {
    filesOpenMock.mockResolvedValue({
      kind: "hostKeyUnknown",
      key: { host: "engine", port: 22, keyType: "ed25519", publicKey: "AAAATEST", fingerprint: "SHA256:abc" },
    });
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await runMenuEntry("web-app", "export");
    await settle();
    expect(document.querySelector("[data-compose-failure]")?.textContent).toContain("export");
  });
});
