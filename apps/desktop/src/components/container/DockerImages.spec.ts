/**
 * The desktop image page, as a person uses it: what the engine has pulled with what uses it, the
 * pull dialog that checks the tag as it is typed, and removal keeping its gate.
 *
 * The menu's mechanics belong to the shared context menu's own suite; what is checked here is what
 * this page's menu offers and what running it does — read from the composable the shell keeps,
 * the way the desktop's pane reads it.
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
  containerImageRemove: vi.fn(async () => {}),
  containerImagePull: vi.fn(async () => "pull-1"),
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

import DockerImages from "@/components/container/DockerImages.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { useContainerStore } from "@/stores/container";
import { i18n } from "@/i18n";
import { containerImagePull, containerImageRemove } from "@/lib/backend/tauri";
import type { ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";

const pullMock = vi.mocked(containerImagePull);
const removeMock = vi.mocked(containerImageRemove);

let app: App | undefined;
let host: HTMLDivElement | undefined;
let related: string[] = [];

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-images",
    session: {
      id: "session-images",
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
    containers: [
      { id: "c1", name: "web", image: "nginx:latest", state: "running", status: "Up", ports: "", createdAt: "now" },
    ],
    images: [
      { id: "i1", repository: "nginx", tag: "latest", size: "10MB", createdAt: "2026-01-01" },
      { id: "i2", repository: "redis", tag: "7", size: "5MB", createdAt: "2026-02-01" },
    ],
    namespaces: [],
    loading: false,
    refreshing: false,
    imagesLoading: false,
    error: null,
    info: null,
    tasks: [],
  };
}

async function mount(): Promise<ContainerSession> {
  related = [];
  const engine = tab();
  const pinia = createPinia();
  setActivePinia(pinia);
  // The session comes from the store, the way the pane hands it over: the pull and the removal
  // act through the store, which only knows sessions it opened.
  const store = useContainerStore();
  await store.connect(engine);
  const withSession = store.sessionFor(engine.id);
  if (!withSession) {
    throw new Error("the session was never opened");
  }
  // The engine's answer in this suite is the fixture's: two images, one container using one.
  withSession.containers = session().containers;
  withSession.images = session().images;

  app = createApp({
    render: () =>
      h(DockerImages, {
        tab: engine,
        session: withSession,
        "onView-related": (reference: string) => related.push(reference),
      }),
  });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
  return withSession;
}

function rows(): HTMLTableRowElement[] {
  return [...(host?.querySelectorAll<HTMLTableRowElement>("tbody tr") ?? [])];
}

beforeEach(() => {
  pullMock.mockClear();
  removeMock.mockClear();
  pullMock.mockResolvedValue("pull-1");
  removeMock.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the image list", () => {
  it("draws one row per image, reference, size and date", async () => {
    await mount();

    const body = rows().filter((row) => row.querySelector("td"));
    expect(body.some((row) => row.textContent?.includes("nginx:latest"))).toBe(true);
    expect(body.some((row) => row.textContent?.includes("redis:7"))).toBe(true);
    expect(body.some((row) => row.textContent?.includes("10MB"))).toBe(true);
    expect(body.some((row) => row.textContent?.includes("2026-01-01"))).toBe(true);
  });

  it("says which images are in use, and which are not", async () => {
    await mount();

    const nginxRow = rows().find((row) => row.textContent?.includes("nginx:latest"));
    const redisRow = rows().find((row) => row.textContent?.includes("redis:7"));
    expect(nginxRow?.querySelector("[data-wb-tag]")?.textContent?.trim()).toBe("In use");
    expect(redisRow?.querySelector("[data-wb-tag]")?.textContent?.trim()).toBe("Unused");
  });

  it("keeps the workspace's removal gate: a consequence, then the acknowledged call", async () => {
    await mount();
    const menu = useContextMenu();

    const more = rows()
      .find((row) => row.textContent?.includes("redis:7"))
      ?.querySelector("button");
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();

    expect(menu.visible.value, "the row's menu is open").toBe(true);
    const removeEntry = menu.entries.value.find((entry) => entry.kind === "action" && entry.id === "remove");
    if (removeEntry === undefined || removeEntry.kind !== "action") {
      throw new Error("the menu has no remove action");
    }

    await removeEntry.run();
    await nextTick();

    // The confirmation stands between the menu and the engine, and it names the consequence.
    expect(removeMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Remove the image “redis:7”?");
    expect(document.body.textContent).toContain("deleted");

    menu.closeMenu();
    await nextTick();
  });
});

describe("the pull dialog", () => {
  it("opens from the page's own button", async () => {
    await mount();
    const pull = document.querySelector("[data-docker-images-pull]");
    expect(pull?.textContent).toContain("Pull");

    (pull as HTMLElement)?.click();
    await nextTick();
    expect(document.querySelector('[aria-label="Image"]')).not.toBeNull();
  });

  it("refuses a tag Docker would refuse, while it is being typed", async () => {
    await mount();
    (document.querySelector("[data-docker-images-pull]") as HTMLElement)?.click();
    await nextTick();

    const name = document.querySelector<HTMLInputElement>('[aria-label="Image"]');
    const tag = document.querySelector<HTMLInputElement>('[aria-label="Tag"]');
    if (!name || !tag) {
      throw new Error("the pull dialog has no fields");
    }

    name.value = "nginx";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    tag.value = ".hidden";
    tag.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    // The dialog is portaled to the body; its words live there.
    expect(document.body.textContent).toContain("not a tag Docker would accept");
  });

  it("sends the reference the engine reads, with no tag meaning no colon", async () => {
    await mount();
    (document.querySelector("[data-docker-images-pull]") as HTMLElement)?.click();
    await nextTick();

    const name = document.querySelector<HTMLInputElement>('[aria-label="Image"]');
    const tag = document.querySelector<HTMLInputElement>('[aria-label="Tag"]');
    if (!name || !tag) {
      throw new Error("the pull dialog has no fields");
    }

    name.value = "nginx";
    name.dispatchEvent(new Event("input", { bubbles: true }));
    await nextTick();

    // The dialog's footer button is the submit; press it as the dialog draws it. The dialog is
    // portaled to the body, so its footer lives there.
    const submit = [...document.querySelectorAll("footer button")].find((entry) => entry.textContent?.includes("Pull"));
    (submit as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(pullMock).toHaveBeenCalledWith("conn-1", { image: "nginx", platform: undefined, allTags: false });
    });
  });
});
