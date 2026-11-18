/**
 * The desktop's batch window: the panel, in a frame of its own.
 *
 * The batch panel's behaviour has a suite of its own, and the window adds nothing to it on
 * purpose — which is exactly why the check here is one: the window carries the panel, full height,
 * with no props of its own and nothing between the frame and the panel's own store.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  commandClassify: vi.fn(),
  batchRun: vi.fn(),
  knownHostTrust: vi.fn(),
  knownHostForget: vi.fn(),
  onBatchEvent: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/batch/bus", () => ({
  startBatchBus: vi.fn(async () => {}),
  onBatchProgress: vi.fn(() => () => {}),
  stopBatchBus: vi.fn(),
}));

import WorkbenchBatchWindow from "@/components/workspace/WorkbenchBatchWindow.vue";
import { i18n } from "@/i18n";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(): Promise<void> {
  app?.unmount();
  host?.remove();

  const pinia = createPinia();
  setActivePinia(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(WorkbenchBatchWindow) });
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
  const body = document.querySelector<HTMLElement>("[data-workbench-batch-window]");
  if (!body) {
    throw new Error("the batch window was not drawn");
  }
  return body;
}

describe("the desktop's batch window", () => {
  it("renders the panel, full height, with nothing between the frame and the panel", async () => {
    await mount();

    // The panel is drawn directly: the host rail is its own element and it fills the window.
    const hosts = windowBody().querySelector("aside");
    expect(hosts).not.toBeNull();
    expect(windowBody().textContent).toContain("Hosts");
    expect(windowBody().textContent).toContain("Command");
    // The panel is the window's only child; the frame adds no chrome of its own.
    expect(windowBody().children.length).toBe(1);
  });
});
