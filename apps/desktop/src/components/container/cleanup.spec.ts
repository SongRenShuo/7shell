/**
 * The cleanup page, as a person uses it: the engine's disk reading first, and the tiers beside the
 * numbers they would change.
 *
 * What is checked here is the page's own discipline: the reading is on the page before anything is
 * offered; the volumes tier starts unchecked and carries its warning; a run sends the acknowledged
 * flag with each checked tier and none of the unchecked ones; and the reading is taken again when
 * the run is over, which is the receipt.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  systemDf: vi.fn(async () => []),
  containerPrune: vi.fn(async () => ({ reclaimed: 0, deleted: [] })),
  containerImagePrune: vi.fn(async () => {}),
  volumePrune: vi.fn(async () => ({ reclaimed: 0, deleted: [] })),
  buildCachePrune: vi.fn(async () => ({ reclaimed: 0, deleted: [] })),
}));

import DockerCleanup from "@/components/container/DockerCleanup.vue";
import { i18n } from "@/i18n";
import { buildCachePrune, containerImagePrune, containerPrune, systemDf, volumePrune } from "@/lib/backend/tauri";
import type { ContainerDiskUsage } from "@/types/container";
import type { ContainerSession } from "@/stores/container";

const dfMock = vi.mocked(systemDf);
const containerPruneMock = vi.mocked(containerPrune);
const imagePruneMock = vi.mocked(containerImagePrune);
const volumePruneMock = vi.mocked(volumePrune);
const buildCachePruneMock = vi.mocked(buildCachePrune);

const USAGE: ContainerDiskUsage[] = [
  { kind: "images", count: 8, size: 1_634_000_000, reclaimable: 1_200_000_000 },
  { kind: "containers", count: 6, size: 59_200_000, reclaimable: 57_900_000 },
  { kind: "volumes", count: 4, size: 1_571_000_000, reclaimable: 1_547_000_000 },
  { kind: "buildCache", count: 12, size: 209_700_000, reclaimable: 209_700_000 },
];

let app: App | undefined;
let host: HTMLDivElement | undefined;

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
    eventsDegraded: false,
  };
}

async function mount(): Promise<void> {
  app = createApp({
    render: () => h(DockerCleanup, { session: session() }),
  });
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
}

function find(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

function ticked(kind: string): boolean {
  const box = find(`[data-cleanup-tier-check="${kind}"]`) as HTMLInputElement | null;
  expect(box, `the ${kind} tier has a checkbox`).not.toBeNull();
  return box?.checked ?? false;
}

/** Confirms the run's dialog, the way a click on the button that names the action does. */
async function confirmRun(): Promise<void> {
  await nextTick();
  const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
    (button) => button.textContent?.trim() === "Clean up",
  );
  expect(confirm, "the dialog carries the run's verb on its button").toBeDefined();
  confirm?.click();
}

beforeEach(() => {
  dfMock.mockReset().mockImplementation(async () => USAGE);
  containerPruneMock.mockReset().mockResolvedValue({ reclaimed: 57_900_000, deleted: ["4d1a1d0c8bd0"] });
  imagePruneMock.mockReset().mockResolvedValue(undefined);
  volumePruneMock.mockReset().mockResolvedValue({ reclaimed: 1_547_000_000, deleted: ["cache-vol"] });
  buildCachePruneMock.mockReset().mockResolvedValue({ reclaimed: 209_700_000, deleted: ["x2nc0zvcigq0"] });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  document.body.innerHTML = "";
});

describe("the reading", () => {
  it("draws the engine's numbers first, each with what it occupies and what it could give back", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    expect(find("[data-cleanup-count]")?.textContent).toBe("8");
    expect(find("[data-cleanup-size]")?.textContent).toBe("1.6 GB");
    expect(find("[data-cleanup-reclaimable]")?.textContent).toBe("1.2 GB");
  });

  it("draws the reclaimable share as the desktops' own bar", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    const bar = find("[data-cleanup-usage] [role='img']");
    expect(bar?.getAttribute("aria-label")).toContain("Images");
  });
});

describe("the tiers", () => {
  it("starts the volumes tier out, and the rest in", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    expect(ticked("containers")).toBe(true);
    expect(ticked("images")).toBe(true);
    expect(ticked("buildCache")).toBe(true);
    expect(ticked("volumes"), "the tier that takes volumes starts out, and stays out until a person picks it up").toBe(
      false,
    );
  });

  it("carries the volume warning beside the tier that takes data", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    expect(find("[data-cleanup-tier='volumes']")?.textContent).toContain("including named ones");
  });
});

describe("the run", () => {
  it("sends the acknowledged flag with each checked tier and none of the unchecked ones", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    find("[data-cleanup-run]")?.click();
    await confirmRun();
    // The receipt read happens after every tier in the loop, so waiting on it makes the call
    // assertions read a finished run rather than a race.
    await vi.waitFor(() => {
      expect(dfMock).toHaveBeenCalledTimes(2);
    });

    expect(containerPruneMock).toHaveBeenCalledWith("conn-1", true);
    expect(imagePruneMock).toHaveBeenCalledWith("conn-1", true);
    expect(buildCachePruneMock).toHaveBeenCalledWith("conn-1", true);
    expect(volumePruneMock, "a checkbox nobody ticked is a verb nobody sent").not.toHaveBeenCalled();
  });

  it("sends the volume prune only after the checkbox itself was picked up", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    const box = find("[data-cleanup-tier-check='volumes']") as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new Event("change"));
    find("[data-cleanup-run]")?.click();
    await confirmRun();
    await vi.waitFor(() => {
      expect(volumePruneMock).toHaveBeenCalled();
    });
    expect(volumePruneMock).toHaveBeenCalledWith("conn-1", true);
  });

  it("reads the df answer again when the run is over", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    expect(dfMock).toHaveBeenCalledTimes(1);
    find("[data-cleanup-run]")?.click();
    await confirmRun();
    await vi.waitFor(() => {
      expect(dfMock, "the fresh reading is the receipt").toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(find("[data-cleanup-report]")?.textContent).toContain("57.9 MB");
    });
  });

  it("keeps going when one tier is refused, and says which one", async () => {
    containerPruneMock.mockRejectedValueOnce({
      code: "CONTAINER-COMMAND-FAILED",
      messageKey: "errors.container.commandFailed",
      detail: "the daemon said no",
    });
    await mount();
    await vi.waitFor(() => {
      expect(find("[data-cleanup-usage]")).not.toBeNull();
    });
    find("[data-cleanup-run]")?.click();
    await confirmRun();
    await vi.waitFor(() => {
      expect(dfMock, "the run walked every tier despite the refusal").toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(find("[data-cleanup-report]")?.textContent).toContain("the daemon said no");
    });
  });
});
