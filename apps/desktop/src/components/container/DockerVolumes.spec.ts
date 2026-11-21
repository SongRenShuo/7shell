/**
 * The volumes page, as a person uses it: the engine's volumes named, and the one way a person
 * loses one.
 *
 * What is checked here is the page's own discipline: a read on open and on refresh and never
 * otherwise; a removal that carries its confirmation; and — the guardrail — a volume the engine
 * refuses because a container still mounts it draws the daemon's own sentence on the strip, beside
 * the catalog's rendering of it.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  volumeList: vi.fn(async () => []),
  volumeRemove: vi.fn(async () => {}),
}));

import DockerVolumes from "@/components/container/DockerVolumes.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { i18n } from "@/i18n";
import { volumeList, volumeRemove } from "@/lib/backend/tauri";
import type { ContainerSession } from "@/stores/container";
import type { VolumeSummary } from "@/types/container";

const listMock = vi.mocked(volumeList);
const removeMock = vi.mocked(volumeRemove);

const NAMED: VolumeSummary = {
  name: "site-data",
  driver: "local",
  mountpoint: "/var/lib/docker/volumes/site-data/_data",
  size: "1.5GB",
  createdAt: "2026-11-10T10:00:00+08:00",
};
const UNSIZED: VolumeSummary = {
  name: "legacy",
  driver: "local",
  mountpoint: "/var/lib/docker/volumes/legacy/_data",
};

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
    render: () => h(DockerVolumes, { session: session() }),
  });
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
}

function rows(): HTMLTableRowElement[] {
  // A row that names a volume, not the table's empty-state row.
  return [...document.querySelectorAll("tbody tr")].filter((row) =>
    row.querySelector("[data-volumes-name]"),
  ) as HTMLTableRowElement[];
}

function body(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([NAMED, UNSIZED]);
  removeMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  document.body.innerHTML = "";
});

describe("the volume list", () => {
  it("draws one row per volume: name, driver, mountpoint, and the size only when the engine gave one", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    const named = rows().find((row) => row.textContent?.includes("site-data"));
    expect(named?.textContent).toContain("local");
    expect(named?.textContent).toContain("/var/lib/docker/volumes/site-data/_data");
    expect(named?.querySelector("[data-volumes-size]")?.textContent?.trim()).toBe("1.5GB");

    // A listing that prints no sizes is a row with a dash, never a zero that would read as
    // "nothing stored" when nobody said that.
    const unsized = rows().find((row) => row.textContent?.includes("legacy"));
    expect(unsized?.querySelector("[data-volumes-size]")?.textContent?.trim()).toBe("—");
  });

  it("is read once when the page opens and again only when the refresh is pressed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(listMock, "no polling").toHaveBeenCalledTimes(1);

    (document.querySelector("[data-volumes-refresh]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("narrows to the names the filter carries", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(2);
    });

    const field = document.querySelector("[data-volumes-refresh]")?.parentElement?.querySelector("input");
    expect(field, "the page head carries the filter").not.toBeNull();
    (field as HTMLInputElement).value = "site";
    field?.dispatchEvent(new Event("input"));
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(1);
    });
    expect(rows()[0]?.textContent).toContain("site-data");
  });
});

describe("the removal", () => {
  async function askRemove(): Promise<void> {
    const menu = useContextMenu();
    const more = rows()
      .find((row) => row.textContent?.includes("site-data"))
      ?.querySelector("button");
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const entry = menu.entries.value.find((item) => item.kind === "action" && item.id === "remove");
    if (entry === undefined || entry.kind !== "action") {
      throw new Error("the row's menu has no remove entry");
    }
    entry.run();
    await nextTick();
  }

  it("asks first, and sends the acknowledged flag when confirmed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    await askRemove();
    expect(body()).toContain("Remove the volume");

    const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.trim() === "Remove",
    );
    expect(confirm, "the dialog carries the verb on its button").toBeDefined();
    confirm?.click();
    await vi.waitFor(() => {
      expect(removeMock).toHaveBeenCalledWith("conn-1", "site-data", true);
    });
  });

  it("draws the engine's own refusal when the volume is still mounted, and does not reload over it", async () => {
    removeMock.mockRejectedValueOnce({
      code: "CONTAINER-COMMAND-FAILED",
      messageKey: "errors.container.commandFailed",
      detail: 'error while removing volume: remove site-data: volume is in use - ["abc123", "def456"]',
    });
    await mount();
    await vi.waitFor(() => {
      expect(rows()).toHaveLength(2);
    });
    await askRemove();

    const confirm = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
      (button) => button.textContent?.trim() === "Remove",
    );
    confirm?.click();
    await vi.waitFor(() => {
      expect(document.querySelector("[data-volumes-failure]"), "the page names the refusal").not.toBeNull();
    });
    // The daemon's own sentence is on the strip, kept verbatim: it names the containers in the
    // words the engine used.
    const refusal = document.querySelector("[data-volumes-refusal]");
    expect(refusal?.textContent).toContain("volume is in use");
    expect(refusal?.textContent).toContain("abc123");

    // Nothing changed on the engine, so nothing is read again: a reload here would wipe the
    // refusal nobody has read yet.
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(body()).not.toContain("Volume  is removed");
  });
});
