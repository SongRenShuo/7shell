/**
 * The image drawer, as it is met: the layers a size question is really about, and the repository's
 * tags wearing the images page's own three state tones.
 *
 * The engine calls are mocked at the transport seam: the layers answer comes from
 * `containerImageHistory`, the tags from `containerImageTags`, and the registry's verdict about a
 * tag from `imageRemoteDigest` — one mock, two verdicts, so both the orange "new version" and the
 * green "up to date" land in one sweep.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerConnect: vi.fn(async () => "conn-1"),
  containerList: vi.fn(async () => []),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(async () => null),
  containerNamespaces: vi.fn(async () => []),
  containerImageInspect: vi.fn(async () => "[]"),
  containerImageHistory: vi.fn(async () => LAYERS),
  containerImageTags: vi.fn(async () => TAGS),
  imageRemoteDigest: vi.fn(async () => ({ reference: "nginx:1.27", remoteDigest: null, upToDate: false })),
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

import ImageDetailDrawer from "@/components/container/ImageDetailDrawer.vue";
import { useContainerStore } from "@/stores/container";
import { i18n } from "@/i18n";
import { containerImageHistory, containerImageTags, imageRemoteDigest } from "@/lib/backend/tauri";
import type { ContainerTab } from "@/stores/terminals";
import type { ContainerImage, ContainerImageRemoteDigest } from "@/types/container";

const historyMock = vi.mocked(containerImageHistory);
const tagsMock = vi.mocked(containerImageTags);
const remoteDigestMock = vi.mocked(imageRemoteDigest);

const LAYERS = [
  { id: "sha256:eee", createdBy: "RUN apt-get install -y curl", size: "24MB", createdAt: "3 weeks ago" },
  { id: "sha256:ddd", createdBy: '/bin/sh -c #(nop) CMD ["nginx"]', size: "0B", createdAt: "3 weeks ago" },
];

const TAGS: ContainerImage[] = [
  { id: "sha256:a1", repository: "nginx", tag: "1.27", size: "192MB", createdAt: "2026-08-24" },
  { id: "sha256:a1", repository: "nginx", tag: "latest", size: "192MB", createdAt: "2026-08-24" },
];

/** The image the drawer is opened on: nginx:1.27, a repository with two tags on this engine. */
const TARGET: ContainerImage = {
  id: "sha256:a1",
  repository: "nginx",
  tag: "1.27",
  size: "192MB",
  createdAt: "2026-08-24",
};

let app: App | undefined;
let host: HTMLDivElement | undefined;

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-drawer",
    session: {
      id: "session-drawer",
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

async function mount(target: ContainerImage = TARGET): Promise<void> {
  const engine = tab();
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useContainerStore();
  await store.connect(engine);
  app = createApp({
    render: () => h(ImageDetailDrawer, { mode: "detail", tabId: engine.id, target }),
  });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  // The drawer's three reads start on mount and each hop of their answers is a microtask; a few
  // ticks let the whole chain land before the first assertion.
  for (let index = 0; index < 5; index += 1) {
    await nextTick();
  }
}

function tagRows(): HTMLElement[] {
  return [...(host?.querySelectorAll<HTMLElement>("[data-image-tag-row]") ?? [])];
}

function tagsButton(): HTMLButtonElement {
  const element = host?.querySelector<HTMLButtonElement>("[data-image-tags-check]");
  if (!element) {
    throw new Error("the tags section drew no sweep button");
  }
  return element;
}

function tagTone(reference: string): string | undefined {
  const row = tagRows().find((entry) => entry.dataset["imageTagRow"] === reference);
  return row?.querySelector("[data-wb-tag]")?.className;
}

async function settle(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await nextTick();
  }
}

beforeEach(() => {
  historyMock.mockClear();
  historyMock.mockResolvedValue(LAYERS);
  tagsMock.mockClear();
  tagsMock.mockResolvedValue(TAGS);
  remoteDigestMock.mockClear();
  remoteDigestMock.mockImplementation(async (_connectionId: string, image: string) => ({
    reference: image,
    remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
    upToDate: false,
  }));
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the layers view", () => {
  it("draws one row per layer: the command, and the size beside it", async () => {
    await mount();

    expect(historyMock).toHaveBeenCalledWith("conn-1", "nginx:1.27");
    const body = host?.textContent ?? "";
    expect(body).toContain("RUN apt-get install -y curl");
    expect(body).toContain("24MB");
    expect(body).toContain("0B");
  });

  it("reads the sizes as numbers, in the numbers' own track", async () => {
    await mount();

    const numerals = [...(host?.querySelectorAll<HTMLElement>(".nums") ?? [])];
    expect(numerals.length).toBeGreaterThan(0);
    expect(numerals.some((entry) => entry.textContent?.includes("24MB"))).toBe(true);
  });
});

describe("the repository's tags", () => {
  it("asks the engine for the image's repository and draws one row per tag", async () => {
    await mount();

    expect(tagsMock).toHaveBeenCalledWith("conn-1", "nginx");
    const references = tagRows().map((row) => row.dataset["imageTagRow"]);
    expect(references).toEqual(["nginx:1.27", "nginx:latest"]);
    expect(tagRows()[0]?.textContent).toContain("192MB");
  });

  it("reads a tag nobody has asked about as the honest third state", async () => {
    await mount();

    for (const row of tagRows()) {
      const tag = row.querySelector("[data-wb-tag]");
      expect(tag?.textContent?.trim()).toBe("Not checked");
      expect(tag?.className).toContain("wb-tag--neutral");
    }
  });

  it("wears the images page's own verdicts after the sweep: new version in orange, up to date in green", async () => {
    remoteDigestMock.mockImplementation(async (_connectionId: string, image: string) => ({
      reference: image,
      remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
      // 1.27 has moved on the registry; latest still names what this engine holds.
      upToDate: image === "nginx:latest",
    }));
    await mount();

    tagsButton().click();
    await settle();

    expect(remoteDigestMock).toHaveBeenCalledTimes(2);
    expect(tagTone("nginx:1.27")).toContain("wb-tag--warning");
    expect(tagRows().find((row) => row.dataset["imageTagRow"] === "nginx:1.27")?.textContent).toContain("New version");
    expect(tagTone("nginx:latest")).toContain("wb-tag--success");
    expect(tagRows().find((row) => row.dataset["imageTagRow"] === "nginx:latest")?.textContent).toContain("Up to date");
  });

  it("carries the sweep's own count on the button while it is out", async () => {
    let pending: ((value: ContainerImageRemoteDigest) => void) | undefined;
    remoteDigestMock.mockImplementation(
      (_connectionId: string, image: string) =>
        new Promise((resolve) => {
          pending = resolve;
          void image;
        }),
    );
    await mount();

    tagsButton().click();
    await settle();

    expect(tagsButton().textContent).toContain("Checking 0/2");
    pending?.({
      reference: "nginx:1.27",
      remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
      upToDate: false,
    });
    await settle();
    pending?.({
      reference: "nginx:latest",
      remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
      upToDate: false,
    });
    await settle();
  });

  it("offers no sweep on an engine whose capability bit said no", async () => {
    await mount();
    const store = useContainerStore();
    const session = store.sessionFor("tab-drawer");
    if (!session) {
      throw new Error("the session was never opened");
    }
    session.info = {
      runtime: "docker",
      cpus: 1,
      memory: 1,
      containersTotal: 1,
      containersByState: [],
      imagesTotal: 2,
      imagesTagged: 2,
      imagesDangling: 0,
      manifestInspectAvailable: false,
    };
    await settle();

    expect(host?.querySelector("[data-image-tags-check]")).toBeNull();
  });

  it("says an unnamed image has no repository to ask, and asks nothing", async () => {
    await mount({ id: "sha256:z9", repository: "<none>", tag: "<none>", size: "5MB", createdAt: "2026-01-01" });

    expect(tagsMock).not.toHaveBeenCalled();
    expect(host?.querySelector("[data-image-tags-section]")?.textContent).toContain("no repository");
  });
});
