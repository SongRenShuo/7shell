/**
 * The desktop Compose page, as a person uses it: the project list with its folded counts, the
 * wizard that writes the file and starts the project, the verbs that keep the workspace's gate,
 * and the log window on the shared stream channel.
 *
 * What is checked is what a wrongly wired page would do — read again without a hand on the
 * refresh, send a file the form had marked invalid, start a project before the file was written,
 * or leave a stream running after its window closed.
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

/** The stream listener the page registers; the spec feeds it lines the way the backend would. */
let streamListener: ((payload: { streamId: string; line: string }) => void) | null = null;

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
      terminal: { terminalType: "xterm-256color", keepaliveSeconds: 0, forwardAgent: false, record: false },
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
  };
}

async function mount(): Promise<void> {
  const engine = tab();
  const pinia = createPinia();
  setActivePinia(pinia);
  app = createApp({
    render: () => h(DockerCompose, { tab: engine, session: session() }),
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
});
