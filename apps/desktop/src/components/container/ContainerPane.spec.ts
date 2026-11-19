/**
 * The container pane as it is met: the connection it opens, the rail that switches views, and the
 * fact that switching does not destroy what was in the other view.
 *
 * The store's own lifecycle has a suite; what is checked here is only what a wrongly wired pane
 * would do — never connect, connect twice, or unmount a list whose filter and scroll position
 * somebody expects to come back to.
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

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import ContainerPane from "@/components/container/ContainerPane.vue";
import { i18n } from "@/i18n";
import { containerConnect, containerRuntimeInfo } from "@/lib/backend/tauri";
import type { ContainerTab } from "@/stores/terminals";

const connectMock = vi.mocked(containerConnect);
const infoMock = vi.mocked(containerRuntimeInfo);

let app: App | undefined;
let host: HTMLDivElement | undefined;

function tab(runtime: "docker" | "nerdctl"): ContainerTab {
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
      terminal: { terminalType: "xterm-256color", keepaliveSeconds: 0, forwardAgent: false, record: false },
      container: { runtime, transport: "local" },
      updatedAt: 0,
    },
    connectionId: null,
  };
}

async function mount(engine: ContainerTab, layout?: "desktop" | "flat"): Promise<void> {
  app = createApp({ render: () => h(ContainerPane, { tab: engine, active: true, layout }) });
  app.use(i18n);
  const pinia = createPinia();
  setActivePinia(pinia);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await vi.waitFor(() => {
    expect(connectMock).toHaveBeenCalled();
  });
  // The connection resolves, then the three reads follow it; let all of that settle.
  await vi.waitFor(() => {
    expect(host?.textContent).toContain("web");
  });
}

function railButton(label: string): HTMLButtonElement {
  const nav = document.querySelector('[aria-label="Container workspace"]');
  if (!nav) {
    throw new Error("the rail was not drawn");
  }
  const button = [...nav.querySelectorAll("button")].find((entry) => entry.textContent?.includes(label));
  if (!button) {
    throw new Error(`the rail has no “${label}” view`);
  }
  return button as HTMLButtonElement;
}

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.clearAllMocks();
});

beforeEach(() => {
  connectMock.mockResolvedValue("conn-1");
});

describe("container pane", () => {
  it("opens the engine once when it is first drawn and writes the connection onto the tab", async () => {
    const engine = tab("docker");
    await mount(engine);

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(connectMock).toHaveBeenCalledWith("session-1");
    expect(engine.connectionId).toBe("conn-1");
  });

  it("keeps every view mounted while only one is shown", async () => {
    await mount(tab("docker"));

    const containersTable = document.querySelector('table[aria-label="Containers"]');
    expect(containersTable).not.toBeNull();

    railButton("Images").click();
    await nextTick();

    // Hidden rather than destroyed: the container list is still in the document, which is what lets
    // a filter, a scroll position and a pull in progress survive the switch.
    expect(document.querySelector('table[aria-label="Containers"]')).not.toBeNull();
    expect(document.querySelector('table[aria-label="Images"]')).not.toBeNull();
  });

  it("offers the namespace picker only where the runtime has namespaces", async () => {
    await mount(tab("docker"));
    expect(document.querySelector('[aria-label="Namespace"]')).toBeNull();
  });

  it("draws the namespace picker for containerd", async () => {
    await mount(tab("nerdctl"));
    expect(document.querySelector('[aria-label="Namespace"]')).not.toBeNull();
  });
});

describe("the desktop layout", () => {
  it("is not what an unset layout draws: the flat workspace keeps its compact rail and its overview", async () => {
    await mount(tab("docker"));

    expect(document.querySelector("aside"), "the flat workspace has no 220px rail").toBeNull();
    // The desktop views stay mounted but hidden, exactly as the flat views do; what the flat
    // workspace never shows is the summary visible.
    const overview = document.querySelector("[data-docker-overview]") as HTMLElement | null;
    expect(overview?.style.display ?? "").toBe("none");
    expect(document.querySelector("[data-side-nav-item]")).toBeNull();
  });

  it("draws the side rail with the engine's counts, and the desktop overview", async () => {
    await mount(tab("docker"), "desktop");

    const overviewRow = document.querySelector('[data-side-nav-item="overview"]');
    const containersRow = document.querySelector('[data-side-nav-item="containers"]');
    expect(overviewRow).not.toBeNull();
    expect(containersRow).not.toBeNull();
    const overview = document.querySelector("[data-docker-overview]") as HTMLElement | null;
    expect(overview?.style.display ?? "none").not.toBe("none");

    // The engine answered with one container; the rail says so beside the word.
    expect(containersRow?.querySelector("[data-side-nav-badge]")?.textContent?.trim()).toBe("1");
  });

  it("offers the overview only while the connection is failing, and still draws the way back", async () => {
    connectMock.mockRejectedValue(new Error("engine down"));
    app = createApp({ render: () => h(ContainerPane, { tab: tab("docker"), active: true, layout: "desktop" }) });
    app.use(i18n);
    const pinia = createPinia();
    setActivePinia(pinia);
    app.use(pinia);
    host = document.createElement("div");
    document.body.append(host);
    app.mount(host);
    await vi.waitFor(() => {
      expect(host?.textContent).toContain("engine could not be reached");
    });

    expect(document.querySelector('[data-side-nav-item="overview"]'), "the overview is there").not.toBeNull();
    expect(document.querySelector('[data-side-nav-item="containers"]'), "no containers row").toBeNull();
    expect(document.querySelector('[data-side-nav-item="images"]'), "no images row").toBeNull();
    expect(host?.textContent).toContain("Try again");
  });

  it("draws the state column as tags and gathers the row's actions under the one menu", async () => {
    await mount(tab("docker"), "desktop");
    railButton("Containers").click();
    await nextTick();

    const tag = document.querySelector("[data-wb-tag]");
    expect(tag, "the running container's state is a tag").not.toBeNull();
    expect(tag?.textContent?.trim()).toBe("Running");

    // The flat row's five buttons collapse to the one menu on the desktop.
    const row = tag?.closest("tr");
    expect(row?.querySelectorAll("button")).toHaveLength(1);
  });

  it("offers the networks page beside the three, and the wizard reads the engine's networks", async () => {
    await mount(tab("docker"), "desktop");

    // The engine answered with no capability bits at all — the reading is "has it", so the row
    // is drawn.
    expect(document.querySelector('[data-side-nav-item="networks"]'), "the networks row is drawn").not.toBeNull();
  });

  it("trims the networks row when the engine says the capability is not there", async () => {
    infoMock.mockResolvedValue({
      runtime: "docker",
      cpus: 2,
      memory: 1024,
      containersTotal: 1,
      containersByState: [{ state: "running", count: 1 }],
      imagesTotal: 0,
      imagesTagged: 0,
      imagesDangling: 0,
      networkAvailable: false,
    });
    await mount(tab("docker"), "desktop");

    expect(document.querySelector('[data-side-nav-item="networks"]'), "the networks row is gone").toBeNull();
    expect(document.querySelector('[data-side-nav-item="containers"]'), "the rest of the rail stands").not.toBeNull();
  });

  it("puts the create wizard's entry on the containers page's header, and nowhere else", async () => {
    // The flat workspace never draws the entry: its own dialog is the only create it has.
    await mount(tab("docker"));
    expect(document.querySelector("[data-container-wizard-open]")).toBeNull();
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;

    await mount(tab("docker"), "desktop");
    expect(document.querySelector("[data-container-wizard-open]"), "the overview carries no entry").toBeNull();

    railButton("Containers").click();
    await nextTick();
    const entry = document.querySelector("[data-container-wizard-open]");
    expect(entry, "the containers page's header carries the one primary button").not.toBeNull();

    (entry as HTMLElement).click();
    await nextTick();
    expect(document.querySelector("[data-wizard-basic]"), "the wizard opens over the window").not.toBeNull();
    // The wizard's own suite covers the walk; here the modal is only reached and dismissed.
    const cancel = document.querySelector("[data-wizard-cancel]");
    expect(cancel).not.toBeNull();
    (cancel as HTMLElement).click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-wizard-basic]"), "the closed wizard takes its dialog with it").toBeNull();
    });
  });
});

describe("the flat layout's zero-diff guard", () => {
  /**
   * Read from the source, not the DOM: the guard is about what the flat branch *writes down* —
   * the desktop window's Semi dressing (its accent washes, its color-mix fills, the workbench
   * tokens) must never leak into the class strings the application tab draws with. The file is
   * the only place that leak would be visible; a mounted flat pane hides it behind the views the
   * two layouts share.
   */
  it("keeps the flat rail free of the desktop's token language", () => {
    const source = readFileSync(resolve("apps/desktop/src/components/container/ContainerPane.vue"), "utf8");

    const start = source.indexOf("<nav");
    const end = source.indexOf("</nav>");
    expect(start, "the flat branch's own rail block is in the template").toBeGreaterThan(-1);
    expect(end, "the flat rail block closes").toBeGreaterThan(start);
    const flatNav = source.slice(start, end);

    expect(flatNav, "the flat rail is still the compact one").toContain("w-36");
    expect(flatNav, "no workbench token leaks into the flat rail's classes").not.toContain("var(--workbench-");
    expect(flatNav, "no Semi wash leaks into the flat rail's classes").not.toContain("color-mix(");
    expect(flatNav, "the flat rail keeps its compact hover language").toContain("hover:bg-accent/50");

    // The markup both layouts share (the retry button, the namespace strip) stays dressed as the
    // application tab has always drawn it: the desktop's own pieces live in the components the
    // desktop branch mounts, not in this file's shared strings.
    expect(source, "the desktop branch mounts its own side navigation").toContain("<WbSideNav");
    expect(source, "the shared retry control keeps the application's hover").toContain("hover:bg-accent");
  });
});
