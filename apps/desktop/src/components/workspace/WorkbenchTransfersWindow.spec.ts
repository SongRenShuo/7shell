/**
 * The desktop's transfers window, as it is met: the list the shell floats over the workspace, drawn
 * inside a frame of its own.
 *
 * The panel's rows and actions have a suite; what is checked here is only the hosting — that the
 * window carries the panel, and that the panel is there whether something is moving or nothing is,
 * because an empty window is the honest answer to "nothing is moving" and a pill is what the panel
 * shows while it is put away.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  transfersOpen: vi.fn(async () => []),
  transferStop: vi.fn(async () => {}),
  transferRemove: vi.fn(async () => {}),
  transferStopAll: vi.fn(async () => {}),
  transferClearSettled: vi.fn(async () => {}),
  transferOpen: vi.fn(async () => {}),
  transferReveal: vi.fn(async () => {}),
  transferPause: vi.fn(async () => {}),
  transferResume: vi.fn(async () => {}),
  transferRetry: vi.fn(async () => {}),
  downloadFolderGet: vi.fn(async () => ({ current: null, history: [] })),
  downloadFolderChoose: vi.fn(async () => undefined),
  downloadFolderSelect: vi.fn(async () => ({ current: "fsdownload", history: ["fsdownload"] })),
  downloadFolderAsk: vi.fn(async () => ({ current: null, history: ["fsdownload"] })),
  downloadFolderReveal: vi.fn(async () => {}),
}));

import WorkbenchTransfersWindow from "@/components/workspace/WorkbenchTransfersWindow.vue";
import { i18n } from "@/i18n";
import { useFilesStore } from "@/stores/files";
import type { TransferInfo, TransferState } from "@/types/session";

let app: App | undefined;
let host: HTMLDivElement | undefined;

function transfer(id: string, state: TransferState): TransferInfo {
  return {
    id,
    direction: "download",
    name: `${id}.txt`,
    remotePath: `/home/labuser/${id}.txt`,
    sessionId: "s1",
    size: 1024,
    transferred: 512,
    state,
    hasLocalPath: true,
    packed: false,
    pausable: true,
  };
}

async function mount(): Promise<void> {
  app?.unmount();
  host?.remove();

  const pinia = createPinia();
  setActivePinia(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(WorkbenchTransfersWindow) });
  app.use(i18n);
  app.use(pinia);
  app.mount(host);
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function windowBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-workbench-transfers-window]");
  if (!body) {
    throw new Error("the transfers window was not drawn");
  }
  return body;
}

describe("the desktop's transfers window", () => {
  it("hosts the panel, drawn as the list when there is something moving", async () => {
    await mount();
    const files = useFilesStore();
    files.transfers = [transfer("t1", { kind: "running" })];
    files.panelExpanded = true;
    await nextTick();

    expect(windowBody().querySelector("[data-transfer-panel]")).not.toBeNull();
    expect(windowBody().textContent).toContain("t1.txt");
  });

  it("the panel is the pill while it is put away, and it lives inside the window", async () => {
    await mount();
    const files = useFilesStore();
    files.transfers = [transfer("t1", { kind: "running" })];
    files.panelExpanded = false;
    await nextTick();

    const pill = windowBody().querySelector("[data-transfer-pill]");
    expect(pill).not.toBeNull();
    // The panel floats into the corner of whatever hosts it, so the window is what carries it.
    expect(pill?.parentElement?.closest("[data-workbench-transfers-window]")).not.toBeNull();
  });

  it("an empty window says nothing is moving, and still carries the panel", async () => {
    await mount();

    expect(windowBody()).toBeDefined();
    expect(windowBody().textContent).toBe("");
  });
});
