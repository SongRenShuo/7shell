/**
 * The create wizard, as it is met: three steps walked with a stepper, fields that refuse what the
 * engine would refuse while they are being typed, the one request the Create button sends — read
 * off the wire, as a table of what was typed against what travelled — and the fact that canceling
 * sends nothing at all.
 *
 * The store's lifecycle has a suite of its own; what is checked here is what a wrongly wired
 * wizard would do — advance with a field the engine would reject, send a half row, start a
 * container it never made, or talk to the engine on the way out.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  containerConnect: vi.fn(async () => "conn-1"),
  containerList: vi.fn(async () => [EXISTING]),
  containerImages: vi.fn(async () => []),
  containerRuntimeInfo: vi.fn(async () => null),
  containerNamespaces: vi.fn(async () => []),
  containerAction: vi.fn(async () => {}),
  containerCreate: vi.fn(async () => {}),
  onContainerStreamLine: vi.fn(async () => () => {}),
  onContainerStreamEnd: vi.fn(async () => () => {}),
}));

import ContainerWizard from "@/components/container/ContainerWizard.vue";
import { i18n } from "@/i18n";
import { containerAction, containerCreate, containerList } from "@/lib/backend/tauri";
import { normalizeShellError } from "@/lib/backend/errors";
import { useContainerStore } from "@/stores/container";
import { useNotificationsStore } from "@/stores/notifications";
import type { ContainerTab } from "@/stores/terminals";

/** What the engine had before anybody created anything: one container, nothing to do with the wizard. */
const EXISTING = {
  id: "c-existing",
  name: "existing",
  image: "nginx:latest",
  state: "running",
  status: "Up",
  ports: "",
  createdAt: "now",
};

const CREATED = {
  id: "c-created",
  name: "web",
  image: "nginx:1.25",
  state: "created",
  status: "Created",
  ports: "",
  createdAt: "now",
};

const listMock = vi.mocked(containerList);
const createMock = vi.mocked(containerCreate);
const actionMock = vi.mocked(containerAction);

let app: App | undefined;
let host: HTMLDivElement | undefined;
let openValues: boolean[] = [];

function tab(): ContainerTab {
  return {
    kind: "container",
    id: "tab-wizard",
    session: {
      id: "session-wizard",
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

async function mount(): Promise<void> {
  const engine = tab();
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useContainerStore();
  await store.connect(engine);
  openValues = [];
  app = createApp({
    render: () =>
      h(ContainerWizard, {
        open: true,
        tabId: engine.id,
        "onUpdate:open": (value: boolean) => openValues.push(value),
      }),
  });
  app.use(i18n);
  app.use(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

function field(name: string): HTMLInputElement {
  const element = document.querySelector<HTMLInputElement>(`[data-wizard-${name}]`);
  if (!element) {
    throw new Error(`the wizard drew no ${name} field on this step`);
  }
  return element;
}

function button(name: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`[data-wizard-${name}]`);
  if (!element) {
    throw new Error(`the wizard drew no ${name} button`);
  }
  return element;
}

/** Types into a field the way a person does, so Vue's v-model sees the input event. */
function type(name: string, value: string): void {
  const element = field(name);
  element.value = value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
}

function words(): string {
  return document.body.textContent ?? "";
}

async function settle(): Promise<void> {
  await nextTick();
  await nextTick();
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([EXISTING]);
  createMock.mockReset();
  createMock.mockResolvedValue(undefined);
  actionMock.mockReset();
  actionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the three steps", () => {
  it("walks basic settings, advanced settings and the review, and reads everything back", async () => {
    await mount();

    expect(field("image")).not.toBeNull();
    expect(words()).toContain("Basic settings");

    type("image", "nginx");
    type("name", "web-1");
    button("next").click();
    await settle();

    expect(button("add-port"), "the advanced step draws its first partition card").not.toBeNull();
    expect(words()).toContain("Advanced settings");

    button("next").click();
    await settle();

    expect(words()).toContain("Review");
    const rows = [...document.querySelectorAll("[data-wizard-review-row]")].map((row) => row.textContent ?? "");
    expect(rows.some((row) => row.includes("nginx"))).toBe(true);
    expect(rows.some((row) => row.includes("web-1"))).toBe(true);
    expect(createMock).not.toHaveBeenCalled();
  });

  it("reads the switches back on the review: start on boot, start after creation, privileged", async () => {
    await mount();

    type("image", "nginx");
    button("autostart").click();
    button("privileged").click();
    await settle();
    button("next").click();
    await settle();
    button("next").click();
    await settle();

    const rows = [...document.querySelectorAll("[data-wizard-review-row]")].map((row) => row.textContent ?? "");
    const labelled = (label: string): string | undefined => rows.find((row) => row.includes(label));
    expect(labelled("Start on boot")).toContain("On");
    expect(labelled("Start after creation")).toContain("On");
    expect(labelled("Privileged")).toContain("On");
    // The one the engine cannot carry is drawn, and says so on its own line.
    expect(labelled("Privileged")).toContain("not applied");
  });

  it("goes back a step without losing what was typed", async () => {
    await mount();

    type("image", "nginx");
    type("name", "web-1");
    button("next").click();
    await settle();
    button("back").click();
    await settle();

    expect(field("image").value).toBe("nginx");
    expect(field("name").value).toBe("web-1");
  });

  it("refuses to walk ahead to a step that has not been reached", async () => {
    await mount();

    document.querySelector<HTMLButtonElement>('[data-wizard-step="3"]')?.click();
    await settle();

    expect(document.querySelector("[data-wizard-review]"), "the review is not drawn before its turn").toBeNull();
    expect(field("image"), "still the basic step").not.toBeNull();
  });
});

describe("what the fields refuse, while they are being typed", () => {
  it("refuses to leave the basic step without an image, and says so", async () => {
    await mount();

    button("next").click();
    await settle();

    expect(document.querySelector("[data-wizard-basic]"), "still the basic step").not.toBeNull();
    expect(words()).toContain("An image is needed.");
    expect(createMock).not.toHaveBeenCalled();
  });

  it("refuses a tag Docker would refuse, while it is being typed", async () => {
    await mount();

    type("image", "nginx:.hidden");
    await settle();

    expect(words()).toContain("not a tag Docker would accept");
    button("next").click();
    await settle();
    expect(document.querySelector("[data-wizard-basic]")).not.toBeNull();
  });

  it("refuses a name the engine would refuse: an alien character, or more than 64 of them", async () => {
    await mount();

    type("image", "nginx");
    type("name", "bad name!");
    await settle();
    expect(words()).toContain("stops at 64 characters");

    type("name", "a".repeat(65));
    await settle();
    expect(words()).toContain("stops at 64 characters");

    type("name", "web-1");
    await settle();
    expect(words()).not.toContain("stops at 64 characters");
  });

  it("refuses a port row with a side missing or not a number", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    button("add-port").click();
    await settle();

    type("port-host", "8080");
    await settle();
    expect(words()).toContain("a row needs both sides");

    button("next").click();
    await settle();
    expect(document.querySelector("[data-wizard-advanced]"), "the half row holds the step").not.toBeNull();
    expect(createMock).not.toHaveBeenCalled();

    type("port-container", "not-a-port");
    await settle();
    expect(words()).toContain("a row needs both sides");
  });

  it("refuses a host port listed twice on one protocol", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    button("add-port").click();
    button("add-port").click();
    await settle();

    const hosts = [...document.querySelectorAll<HTMLInputElement>("[data-wizard-port-host]")];
    for (const host of hosts) {
      host.value = "8080";
      host.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const containers = [...document.querySelectorAll<HTMLInputElement>("[data-wizard-port-container]")];
    for (const [index, container] of containers.entries()) {
      container.value = String(80 + index);
      container.dispatchEvent(new Event("input", { bubbles: true }));
    }
    await settle();

    expect(words()).toContain("is listed more than once");
    expect(words()).toContain("8080");
  });

  it("refuses a volume row with a side missing", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    button("add-volume").click();
    await settle();

    type("volume-host", "/data");
    await settle();
    expect(words()).toContain("needs a host path and a container path");
  });

  it("refuses an environment row with no key", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    button("add-env").click();
    await settle();

    type("env-value", "x");
    await settle();
    expect(words()).toContain("needs a key");
  });

  it("refuses a memory limit that is not a whole number of megabytes", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    button("memory-enabled").click();
    await settle();

    type("memory-limit", "half");
    await settle();
    expect(words()).toContain("a whole number of megabytes");

    button("next").click();
    await settle();
    expect(document.querySelector("[data-wizard-advanced]")).not.toBeNull();
  });
});

describe("the request the Create button sends", () => {
  interface MappingCase {
    /** What the case is about, as the failure would name it. */
    name: string;
    fill: () => Promise<void>;
    expected: Record<string, unknown>;
  }

  const cases: MappingCase[] = [
    {
      name: "the minimum: an image, and the restart policy the switches decide",
      fill: async () => {
        type("image", "nginx");
        await settle();
        button("next").click();
        await settle();
        button("next").click();
        await settle();
      },
      expected: { image: "nginx", restartPolicy: "no" },
    },
    {
      name: "start on boot is the restart policy the engine spells always",
      fill: async () => {
        type("image", "nginx");
        button("autostart").click();
        await settle();
        button("next").click();
        await settle();
        button("next").click();
        await settle();
      },
      expected: { image: "nginx", restartPolicy: "always" },
    },
    {
      name: "the carried advanced fields mapped whole, an empty value travelling as KEY=",
      fill: async () => {
        type("image", "nginx:1.25");
        type("name", "web");
        button("autostart").click();
        await settle();
        button("next").click();
        await settle();
        button("add-port").click();
        button("add-port").click();
        await settle();
        type("port-host", "8080");
        type("port-container", "80");
        const hosts = document.querySelectorAll<HTMLInputElement>("[data-wizard-port-host]");
        const secondHost = hosts[1];
        if (!secondHost) {
          throw new Error("the second port row was not drawn");
        }
        secondHost.value = "53";
        secondHost.dispatchEvent(new Event("input", { bubbles: true }));
        const containers = document.querySelectorAll<HTMLInputElement>("[data-wizard-port-container]");
        const secondContainer = containers[1];
        if (!secondContainer) {
          throw new Error("the second port row was not drawn");
        }
        secondContainer.value = "53";
        secondContainer.dispatchEvent(new Event("input", { bubbles: true }));
        button("add-volume").click();
        await settle();
        type("volume-host", "/data");
        type("volume-container", "/srv");
        button("add-env").click();
        button("add-env").click();
        await settle();
        type("env-key", "KEY");
        type("env-value", "VALUE");
        const keys = document.querySelectorAll<HTMLInputElement>("[data-wizard-env-key]");
        const secondKey = keys[1];
        if (!secondKey) {
          throw new Error("the second env row was not drawn");
        }
        secondKey.value = "KEY2";
        secondKey.dispatchEvent(new Event("input", { bubbles: true }));
        type("command", "nginx -g 'daemon off;'");
        await settle();
        button("next").click();
        await settle();
      },
      expected: {
        image: "nginx:1.25",
        name: "web",
        ports: [
          { hostPort: 8080, containerPort: 80, protocol: "tcp" },
          { hostPort: 53, containerPort: 53, protocol: "tcp" },
        ],
        volumes: [{ source: "/data", destination: "/srv" }],
        env: ["KEY=VALUE", "KEY2="],
        restartPolicy: "always",
        command: "nginx -g 'daemon off;'",
      },
    },
    {
      name: "a blank row travels as nothing at all",
      fill: async () => {
        type("image", "nginx");
        await settle();
        button("next").click();
        await settle();
        button("add-port").click();
        button("add-volume").click();
        button("add-env").click();
        await settle();
        button("next").click();
        await settle();
      },
      expected: { image: "nginx", restartPolicy: "no" },
    },
  ];

  for (const entry of cases) {
    it(`maps ${entry.name}`, async () => {
      await mount();
      await entry.fill();

      button("create").click();
      await vi.waitFor(() => {
        expect(createMock).toHaveBeenCalled();
      });
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(createMock).toHaveBeenCalledWith("conn-1", entry.expected);
      // The engine never started anything on the wizard's behalf in these cases: the refreshed
      // list holds no container it could name, and the review promised no start.
      expect(actionMock).not.toHaveBeenCalled();
    });
  }
});

describe("the start the review promised", () => {
  it("starts the container it created, and says so once the engine confirms", async () => {
    listMock.mockResolvedValueOnce([EXISTING]).mockResolvedValue([EXISTING, CREATED]);
    await mount();

    type("image", "nginx:1.25");
    type("name", "web");
    await settle();
    button("next").click();
    await settle();
    button("next").click();
    await settle();
    button("create").click();

    await vi.waitFor(() => {
      expect(actionMock).toHaveBeenCalledWith("conn-1", "c-created", "start", false);
    });
    await vi.waitFor(() => {
      expect(openValues[openValues.length - 1]).toBe(false);
    });

    const notices = useNotificationsStore();
    expect(notices.notices[0]?.titleKey).toBe("container.wizard.notice.createdStarted");
    expect(notices.notices[0]?.params).toEqual({ name: "web" });
  });

  it("keeps the creation when the start fails, and still closes with its receipt", async () => {
    listMock.mockResolvedValueOnce([EXISTING]).mockResolvedValue([EXISTING, CREATED]);
    actionMock.mockRejectedValue(new Error("engine refused the start"));
    await mount();

    type("image", "nginx:1.25");
    type("name", "web");
    await settle();
    button("next").click();
    await settle();
    button("next").click();
    await settle();
    button("create").click();

    await vi.waitFor(() => {
      expect(openValues[openValues.length - 1]).toBe(false);
    });
    const notices = useNotificationsStore();
    expect(notices.notices[0]?.titleKey).toBe("container.wizard.notice.created");
  });

  it("carries the engine's refusal in the wizard's own words when the create is rejected", async () => {
    // The bridge hands the store a normalized envelope, and the words the catalog keeps for a
    // refused command are what the wizard draws, beside the code — the same words the pane's
    // banner would.
    createMock.mockRejectedValue(
      normalizeShellError(
        {
          code: "0x1003",
          messageKey: "errors.container.commandFailed",
          messageParams: { operation: "container_create" },
          detail: "port is already allocated",
          origin: { subsystem: "docker" },
          outcome: "failed",
        },
        "container_create",
      ),
    );
    await mount();

    type("image", "nginx");
    await settle();
    button("next").click();
    await settle();
    button("next").click();
    await settle();
    button("create").click();

    await vi.waitFor(() => {
      expect(words()).toContain("The container runtime rejected container_create.");
    });
    expect(words()).toContain("0x1003");
    expect(openValues, "the wizard stays open to let the refusal be read").toEqual([]);
    // The refused create is not a reason to start anything.
    expect(actionMock).not.toHaveBeenCalled();
  });
});

describe("canceling", () => {
  it("sends nothing to the engine on the way out, from either step", async () => {
    await mount();

    type("image", "nginx");
    type("name", "web-1");
    button("next").click();
    await settle();
    button("add-port").click();
    await settle();
    type("port-host", "8080");
    type("port-container", "80");
    await settle();

    button("cancel").click();
    await settle();

    expect(openValues).toEqual([false]);
    expect(createMock).not.toHaveBeenCalled();
    expect(actionMock).not.toHaveBeenCalled();
    // The refresh the store does on its own connect is all the traffic there was.
    expect(listMock).toHaveBeenCalledTimes(1);
  });

  it("opens empty the next time, whatever the last visit left behind", async () => {
    await mount();

    type("image", "nginx");
    type("name", "web-1");
    button("next").click();
    await settle();
    button("add-port").click();
    await settle();
    button("cancel").click();
    await settle();
    app?.unmount();
    host?.remove();
    app = undefined;
    host = undefined;

    await mount();
    expect(field("image").value).toBe("");
    expect(field("name").value).toBe("");
    button("next").click();
    await settle();
    expect(document.querySelectorAll("[data-wizard-port-host]").length).toBe(0);
  });
});
