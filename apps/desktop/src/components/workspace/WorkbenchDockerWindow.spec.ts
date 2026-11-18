/**
 * The desktop's Docker window, as it is met: the asking for the engine, and what it draws while
 * there is none yet.
 *
 * The container workspace's own lifecycle has a suite; what is checked here is only what a desktop
 * window adds to it — that the open is made when the window is drawn, that until the engine answers
 * the window says so instead of showing an empty room, and that the workspace appears only once the
 * window's tab is holding the connection. A refusal keeps the window, with the reason and a way
 * back, because a desktop window has no strip to fall back to.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick, reactive } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerConnect: vi.fn(async () => "conn-1"),
  desktopEngineOpen: vi.fn(async () => "conn-1"),
  containerDisconnect: vi.fn(async () => {}),
  containerList: vi.fn(async () => [
    {
      id: "0123456789abcdef0123456789abcdef",
      name: "web",
      image: "nginx:latest",
      state: "running",
      status: "Up",
      ports: "",
      createdAt: "now",
    },
  ]),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(async () => ({
    runtime: "docker",
    cpus: 2,
    memory: 1024,
    containersTotal: 1,
    containersByState: [{ state: "running", count: 1 }],
    imagesTotal: 0,
    imagesTagged: 0,
    imagesDangling: 0,
  })),
  containerNamespaces: vi.fn(async () => []),
  containerSetNamespace: vi.fn(async () => {}),
  containerAction: vi.fn(async () => {}),
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
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

import WorkbenchDockerWindow from "@/components/workspace/WorkbenchDockerWindow.vue";
import { i18n } from "@/i18n";
import { desktopEngineOpen } from "@/lib/backend/tauri";
import type { ContainerTab } from "@/stores/terminals";

// A desktop session's engine rides the connection the session already holds, so the window's open
// is the desktop bridge, not the container session's connect.
const connectMock = vi.mocked(desktopEngineOpen);

let app: App | undefined;
let host: HTMLDivElement | undefined;

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-1",
    session: {
      id: "desktop-1",
      name: "lab desktop",
      protocol: "linuxDesk",
      host: "desk.test",
      port: 22,
      user: "root",
      auth: { method: "password", hasSecret: true },
      terminal: { terminalType: "xterm-256color", keepaliveSeconds: 0, forwardAgent: false, record: false },
      updatedAt: 0,
    },
    connectionId: null,
  };
}

/** Draws the window over a reactive tab, because the connection id written back is what flips it. */
async function mount(engine: ContainerTab): Promise<void> {
  app?.unmount();
  host?.remove();

  const pinia = createPinia();
  setActivePinia(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(WorkbenchDockerWindow, { tab: reactive(engine), active: true }) });
  app.use(i18n);
  app.use(pinia);
  app.mount(host);
  await nextTick();
}

beforeEach(() => {
  connectMock.mockClear();
  connectMock.mockResolvedValue("conn-1");
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function windowBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-workbench-docker-window]");
  if (!body) {
    throw new Error("the docker window was not drawn");
  }
  return body;
}

describe("the desktop's docker window", () => {
  it("asks for the engine when it is drawn, and draws the workspace once the connection is held", async () => {
    const engine = tab();
    await mount(engine);

    expect(connectMock).toHaveBeenCalledWith("desktop-1");
    // Before the engine answers there is no workspace to draw: the rail the pane carries is the
    // thing that only exists behind a connection.
    expect(document.querySelector('[aria-label="Container workspace"]')).toBeNull();

    await vi.waitFor(() => {
      expect(engine.connectionId).toBe("conn-1");
    });
    await vi.waitFor(() => {
      expect(windowBody().textContent).toContain("web");
    });
    expect(document.querySelector('[aria-label="Container workspace"]')).not.toBeNull();
  });

  it("says the connection is being made, and does not pretend a workspace is there", async () => {
    let answer: ((value: string) => void) | undefined;
    const pending = new Promise<string>((resolve) => {
      answer = resolve;
    });
    connectMock.mockReturnValueOnce(pending);

    await mount(tab());

    expect(windowBody().textContent).toContain("Opening a connection");
    expect(document.querySelector('[aria-label="Container workspace"]')).toBeNull();
    answer?.("conn-1");
    await nextTick();
  });

  it("keeps the window and shows the reason when the engine refuses, and retries through the store", async () => {
    connectMock.mockRejectedValueOnce(new Error("no engine on this machine"));

    await mount(tab());

    // The refusal is the envelope the store keeps, said where the person is looking — the window's
    // failed state, not a strip tab, because a desktop window has no strip to fall back to.
    await vi.waitFor(() => {
      expect(windowBody().textContent).toContain("The engine could not be reached.");
    });
    expect(windowBody().textContent).toContain("APP-INTERNAL");
    expect(document.querySelector('[aria-label="Container workspace"]')).toBeNull();
    expect(connectMock).toHaveBeenCalledTimes(1);

    connectMock.mockResolvedValue("conn-1");
    const retry = [...windowBody().querySelectorAll("button")].find((entry) =>
      entry.textContent?.includes("Try again"),
    );
    expect(retry).not.toBeUndefined();
    retry?.click();

    await vi.waitFor(() => {
      expect(connectMock).toHaveBeenCalledTimes(2);
    });
  });
});
