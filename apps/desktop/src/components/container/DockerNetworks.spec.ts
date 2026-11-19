/**
 * The desktop networks page, as a person uses it: the engine's networks with the readings the
 * columns carry, the form that checks the addresses while they are typed, and removal keeping the
 * workspace's gate — with the engine's guardrail sentence drawn when the refusal comes back.
 *
 * The menu's mechanics belong to the shared context menu's own suite; what is checked here is what
 * this page offers and what running it does. The list is read once, and only once: a timer would
 * make the page guess, and a network does not appear by itself.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  networkList: vi.fn(async () => []),
  networkCreate: vi.fn(async () => {}),
  networkRemove: vi.fn(async () => {}),
}));

import DockerNetworks from "@/components/container/DockerNetworks.vue";
import { useContextMenu } from "@/composables/useContextMenu";
import { i18n } from "@/i18n";
import { networkCreate, networkList, networkRemove } from "@/lib/backend/tauri";
import { normalizeShellError } from "@/lib/backend/errors";
import type { ContainerSession } from "@/stores/container";
import type { ContainerTab } from "@/stores/terminals";
import type { NetworkSummary } from "@/types/container";

const listMock = vi.mocked(networkList);
const createMock = vi.mocked(networkCreate);
const removeMock = vi.mocked(networkRemove);

const BRIDGE: NetworkSummary = {
  name: "bridge",
  driver: "bridge",
  subnet: "172.17.0.0/16",
  gateway: "172.17.0.1",
  ipv6: false,
  internal: false,
  containers: 3,
};
const OWN: NetworkSummary = {
  name: "mem-net-test",
  driver: "bridge",
  subnet: "172.62.0.0/24",
  gateway: "172.62.0.1",
  ipv6: true,
  internal: false,
  containers: 0,
};

let app: App | undefined;
let host: HTMLDivElement | undefined;

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-networks",
    session: {
      id: "session-networks",
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
    render: () => h(DockerNetworks, { tab: engine, session: session() }),
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

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([BRIDGE, OWN]);
  createMock.mockReset().mockResolvedValue(undefined);
  removeMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the network list", () => {
  it("draws one row per network: name, driver, subnet, gateway, IPv6 and the container count", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    const bridge = rows().find((row) => row.textContent?.includes("bridge"));
    expect(bridge?.textContent).toContain("172.17.0.0/16");
    expect(bridge?.textContent).toContain("172.17.0.1");
    expect(bridge?.querySelector("[data-networks-container-count]")?.textContent?.trim()).toBe("3");

    const own = rows().find((row) => row.textContent?.includes("mem-net-test"));
    expect(own?.textContent).toContain("IPv6");
    expect(own?.querySelector("[data-networks-container-count]")?.textContent?.trim()).toBe("0");
  });

  it("is read once when the page opens and again only when the refresh is pressed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(1);
    });

    // No timer ever calls again: the page waits for a hand on the refresh button.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(listMock, "no polling").toHaveBeenCalledTimes(1);

    (document.querySelector("[data-networks-refresh]") as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("narrows to the names the filter carries", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    const search = host?.querySelector<HTMLInputElement>('input[aria-label="Filter by network name"]');
    if (!search) {
      throw new Error("the page head has no search field");
    }
    search.value = "mem-net";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    await settle();

    const visible = rows().filter((row) => row.textContent?.includes("mem-net-test"));
    expect(visible).toHaveLength(1);
    expect(rows(), "the bridge row is filtered away").toHaveLength(1);
  });

  it("says so when the engine has no networks", async () => {
    listMock.mockResolvedValue([]);
    await mount();
    await vi.waitFor(() => {
      expect(body()).toContain("no networks of its own");
    });
  });

  it("names the reading while the list is on its way", async () => {
    listMock.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve([BRIDGE, OWN]), 40)));
    await mount();
    await settle();
    expect(document.querySelector("[data-networks-loading]"), "the loading line is drawn").not.toBeNull();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    expect(document.querySelector("[data-networks-loading]")).toBeNull();
  });
});

describe("the create form", () => {
  async function open(): Promise<void> {
    (document.querySelector("[data-networks-create]") as HTMLElement)?.click();
    await settle();
  }

  function fill(selector: string, value: string): void {
    const field = document.querySelector<HTMLInputElement>(`[data-networks-${selector}]`);
    if (!field) {
      throw new Error(`the create form drew no ${selector} field`);
    }
    field.value = value;
    field.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("opens from the page's own primary button", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await open();
    expect(document.querySelector("[data-networks-name]")).not.toBeNull();
  });

  it("refuses a subnet that is not in CIDR form, while it is being typed", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await open();

    fill("name", "mem-net-test");
    fill("subnet", "172.62.0.0");
    await settle();
    expect(body()).toContain("not a subnet in CIDR form");

    fill("subnet", "172.62.0.0/24");
    await settle();
    expect(body()).not.toContain("not a subnet in CIDR form");
    expect(body()).toContain("address/prefix");
  });

  it("refuses a gateway that is not an address", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await open();

    fill("gateway", "172.62.0.999");
    await settle();
    expect(body()).toContain("not an IP address");

    fill("gateway", "172.62.0.1");
    await settle();
    expect(body()).not.toContain("not an IP address");
  });

  it("sends the network the engine reads, the engine's own defaults left off the wire", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await open();

    fill("name", "mem-net-test");
    fill("subnet", "172.62.0.0/24");
    fill("gateway", "172.62.0.1");
    await settle();

    const submit = document.querySelector("[data-networks-submit]") as HTMLElement;
    expect(submit?.hasAttribute("disabled"), "a complete form is ready").toBe(false);
    submit?.click();
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalledWith("conn-1", {
        name: "mem-net-test",
        driver: undefined,
        subnet: "172.62.0.0/24",
        gateway: "172.62.0.1",
      });
    });
    // The list comes back fresh once the engine has answered.
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("holds the step while the form is incomplete", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalled();
    });
    await open();
    await settle();

    const submit = document.querySelector("[data-networks-submit]") as HTMLButtonElement;
    expect(submit?.hasAttribute("disabled"), "no name, no create").toBe(true);
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe("removal", () => {
  async function askRemove(): Promise<void> {
    const menu = useContextMenu();
    const more = rows()
      .find((row) => row.textContent?.includes("mem-net-test"))
      ?.querySelector("button");
    more?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await nextTick();
    const entry = menu.entries.value.find((item) => item.kind === "action" && item.id === "remove");
    if (entry === undefined || entry.kind !== "action") {
      throw new Error("the menu has no remove action");
    }
    entry.run();
    menu.closeMenu();
    await settle();
  }

  it("keeps the workspace's gate: a consequence before the engine hears anything", async () => {
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await askRemove();

    expect(removeMock).not.toHaveBeenCalled();
    expect(body()).toContain("Remove the network “mem-net-test”?");
    expect(body()).toContain("refuses to remove a network while any are attached");
  });

  it("draws the guardrail's own sentence when the engine says the network is still in use", async () => {
    removeMock.mockRejectedValue(
      normalizeShellError(
        {
          code: "CONTAINER-NETWORK-IN-USE",
          messageKey: "errors.container.networkInUse",
          messageParams: { network: "mem-net-test", containers: "2" },
          origin: { subsystem: "container" },
          outcome: "notSent",
        },
        "network_remove",
      ),
    );
    await mount();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    await askRemove();

    const confirm = [...document.querySelectorAll("footer button, dialog button, button")].find(
      (button) => button.textContent?.trim() === "Remove",
    );
    (confirm as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(removeMock).toHaveBeenCalled();
    });

    // The refusal is the catalog's sentence, with the network and the count in it — the page's
    // own strip draws exactly that, never a raw code alone.
    await vi.waitFor(() => {
      expect(document.querySelector("[data-networks-failure]"), "the page names the refusal").not.toBeNull();
    });
    const strip = document.querySelector("[data-networks-failure]");
    expect(strip?.textContent).toContain("mem-net-test");
    expect(strip?.textContent).toContain("2 containers attached");
    expect(strip?.textContent).toContain("Disconnect them before removing it");
  });
});
