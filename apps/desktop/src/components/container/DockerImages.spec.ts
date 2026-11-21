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
  dockerInfo: vi.fn(async () => ({ mirrors: ["https://docker.gmssh.com/"] })),
  imageRemoteDigest: vi.fn(async () => ({
    reference: "redis:7",
    remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
    upToDate: false,
    source: "docker.gmssh.com",
  })),
}));

import DockerImages from "@/components/container/DockerImages.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { useContainerStore } from "@/stores/container";
import { i18n } from "@/i18n";
import { containerImagePull, containerImageRemove, dockerInfo, imageRemoteDigest } from "@/lib/backend/tauri";
import type { ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";

const pullMock = vi.mocked(containerImagePull);
const removeMock = vi.mocked(containerImageRemove);
const remoteDigestMock = vi.mocked(imageRemoteDigest);
const dockerInfoMock = vi.mocked(dockerInfo);

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
  remoteDigestMock.mockClear();
  dockerInfoMock.mockClear();
  pullMock.mockResolvedValue("pull-1");
  removeMock.mockResolvedValue(undefined);
  remoteDigestMock.mockImplementation(async (_connectionId: string, image: string) => ({
    reference: image,
    remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
    upToDate: false,
    source: "docker.gmssh.com",
  }));
  dockerInfoMock.mockResolvedValue({ mirrors: ["https://docker.gmssh.com/"] });
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

// -- the update flow ---------------------------------------------------------------

/** Opens the redis row's menu and runs the entry the test names. */
async function runMenuEntry(id: string): Promise<void> {
  const menu = useContextMenu();
  const more = rows()
    .find((row) => row.textContent?.includes("redis:7"))
    ?.querySelector("button");
  more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  await nextTick();
  const entry = menu.entries.value.find((item) => item.kind === "action" && item.id === id);
  if (entry === undefined || entry.kind !== "action") {
    throw new Error(`the menu has no ${id} action`);
  }
  await entry.run();
  await nextTick();
  menu.closeMenu();
  await nextTick();
}

/** The redis row's update tag, once the flow has drawn one. */
function updateTag(): string | null {
  return (
    rows()
      .find((row) => row.textContent?.includes("redis:7"))
      ?.querySelector("[data-docker-image-update]")
      ?.textContent?.trim() ?? null
  );
}

function footerButton(label: string): HTMLElement | null {
  const found = [...document.querySelectorAll<HTMLElement>("footer button")].find((entry) =>
    entry.textContent?.includes(label),
  );
  return found ?? null;
}

async function checkRedis(): Promise<void> {
  await runMenuEntry("checkUpdate");
  await vi.waitFor(() => expect(remoteDigestMock).toHaveBeenCalledWith("conn-1", "redis:7"));
}

/**
 * Walks the dialog from its current step to the step named, pressing Continue as it appears.
 *
 * The wait after each press has to fail while the DOM still shows the step the press left — a
 * first check that runs before Vue's flush would pass on the stale label and the walk would take
 * two steps for one press. So the wait is "no longer the step it was, and now the one asked for".
 */
async function walkTo(step: number): Promise<void> {
  const label = (): string => document.querySelector("[data-update-step-label]")?.textContent?.trim() ?? "";
  for (let seen = label(); !seen.includes(`Step ${step} of 5`); seen = label()) {
    await vi.waitFor(() => expect(footerButton("Continue")).not.toBeNull());
    footerButton("Continue")?.click();
    const previous = seen;
    const next = Number(/Step (\d+) of/.exec(previous)?.[1] ?? "0") + 1;
    await vi.waitFor(() => {
      const current = label();
      expect(current, "the press moved the dialog off the step it was on").not.toContain(previous);
      expect(current).toContain(`Step ${next} of 5`);
    });
  }
}

describe("the update flow", () => {
  it("asks the registry from the row's menu, and draws what it answered", async () => {
    await mount();
    await checkRedis();
    await vi.waitFor(() => expect(updateTag()).toBe("New version"));
  });

  it("says so, equally, when the registry names what the engine already has", async () => {
    remoteDigestMock.mockImplementation(async (_connectionId: string, image: string) => ({
      reference: image,
      remoteDigest: "sha256:66a6306db78bf2dbf3487f293aa8d6990d8e506fdffab9cc43fe422becf886e4",
      upToDate: true,
      source: "docker.gmssh.com",
    }));
    await mount();
    await checkRedis();
    await vi.waitFor(() => expect(updateTag()).toBe("Up to date"));
  });

  it("keeps the registry's refusal as its own sentence, never as an up-to-date", async () => {
    remoteDigestMock.mockRejectedValue({ code: "IMAGE-MANIFEST-UNAVAILABLE" });
    await mount();
    await checkRedis();
    await vi.waitFor(() => expect(updateTag()).toBe("Check failed"));
  });

  it("walks the five questions, and the last one starts the pull the page already had", async () => {
    await mount();
    await checkRedis();
    await runMenuEntry("update");
    expect(document.querySelector("[data-update-step-label]")?.textContent).toContain("Step 1 of 5");
    // No container on the fixture runs redis, and the step says that rather than listing an empty box.
    expect(document.querySelector("[data-update-step-affected]")?.textContent).toContain("No container");
    await walkTo(5);
    expect(document.querySelector("[data-update-step-label]")?.textContent).toContain("Step 5 of 5");
    document.querySelector("[data-update-confirm]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => {
      expect(pullMock).toHaveBeenCalledWith("conn-1", { image: "redis:7", platform: undefined, allTags: false });
    });
    await nextTick();
    expect(document.querySelector("[data-update-confirm]"), "the confirm closed the dialog").toBeNull();
  });

  it("offers the way out on every step, and leaving starts nothing", async () => {
    await mount();
    await checkRedis();
    await runMenuEntry("update");
    footerButton("Continue")?.click();
    await nextTick();
    expect(document.querySelector("[data-update-step-label]")?.textContent).toContain("Step 2 of 5");
    footerButton("Cancel")?.click();
    await nextTick();
    expect(document.querySelector("[data-update-confirm]")).toBeNull();
    expect(pullMock).not.toHaveBeenCalled();
  });

  it("reads the daemon's mirrors when the dialog opens, not from a stale card", async () => {
    await mount();
    await checkRedis();
    await runMenuEntry("update");
    await walkTo(3);
    expect(document.querySelector("[data-update-step-mirrors]")).not.toBeNull();
    await vi.waitFor(() => expect(dockerInfoMock).toHaveBeenCalledWith("conn-1"));
    expect(document.querySelector("[data-update-step-mirrors]")?.textContent).toContain("https://docker.gmssh.com/");
  });

  it("does not start a second pull while one is already running for the image", async () => {
    const withSession = await mount();
    await checkRedis();
    await runMenuEntry("update");
    await walkTo(5);
    document.querySelector("[data-update-confirm]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(pullMock).toHaveBeenCalledTimes(1));
    // The first pull is still running; a second update of the same image walks the same gate and
    // leaves without starting anything.
    expect(withSession.tasks.some((task) => task.kind === "pull" && task.status === "running")).toBe(true);
    await runMenuEntry("update");
    await walkTo(5);
    document.querySelector("[data-update-confirm]")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() =>
      expect(document.querySelector("[data-update-confirm]"), "the guard closed the dialog").toBeNull(),
    );
    expect(pullMock).toHaveBeenCalledTimes(1);
  });

  it("forgets the answer once a pull of that image has finished", async () => {
    const withSession = await mount();
    await checkRedis();
    await vi.waitFor(() => expect(updateTag()).toBe("New version"));
    withSession.tasks.push({
      id: "image-1",
      kind: "pull",
      image: "redis:7",
      status: "done",
      lines: [],
      layers: new Map(),
      startedAt: 0,
      endedAt: 1,
      streamId: null,
      failure: null,
      streamError: null,
    });
    await nextTick();
    expect(updateTag()).toBeNull();
  });

  it("offers the manual pull only when the engine cannot answer the check", async () => {
    const withSession = await mount();
    withSession.info = {
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
    await nextTick();
    const menu = useContextMenu();
    const more = rows()
      .find((row) => row.textContent?.includes("redis:7"))
      ?.querySelector("button");
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const ids = menu.entries.value.map((entry) => (entry.kind === "action" ? entry.id : ""));
    expect(ids).not.toContain("checkUpdate");
    expect(ids).not.toContain("update");
    expect(ids).toContain("remove");
    menu.closeMenu();
    await nextTick();
  });
});
