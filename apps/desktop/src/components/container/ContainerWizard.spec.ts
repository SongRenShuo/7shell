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

import ContainerWizard, { type ContainerClonePrefill } from "@/components/container/ContainerWizard.vue";
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

async function mount(
  networkOptions?: { value: string; label: string }[],
  prefill?: ContainerClonePrefill,
): Promise<void> {
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
        ...(networkOptions ? { networkOptions } : {}),
        ...(prefill ? { prefill } : {}),
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

/**
 * Chooses an option of one of the wizard's dropdowns, the way a pointer commits a choice: the
 * trigger is pressed, the list opens beside it, and the option is chosen by moving onto it and
 * letting go — the sequence the list's own library commits on.
 */
async function choose(ariaLabel: string, label: string): Promise<void> {
  const trigger = document.querySelector<HTMLButtonElement>(`button[aria-label="${ariaLabel}"]`);
  if (!trigger) {
    throw new Error(`the wizard drew no “${ariaLabel}” dropdown on this step`);
  }
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
  await pause();
  const option = [...document.querySelectorAll("[role='option']")].find((entry) =>
    entry.textContent?.includes(label),
  ) as HTMLElement | undefined;
  if (!option) {
    throw new Error(`the “${ariaLabel}” dropdown has no “${label}” option`);
  }
  option.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, button: 0 }));
  option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, button: 0 }));
  await pause();
}

/** The dropdown's library commits outside Vue's microtasks; a beat of real time lets it land. */
async function pause(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await nextTick();
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
    // Every advanced field travels now: nothing on the review is marked "not applied" any more.
    expect(words()).not.toContain("not applied");
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
      name: "the minimum: an image, the restart policy the switches decide, and the CPU preset the form holds",
      fill: async () => {
        type("image", "nginx");
        await settle();
        button("next").click();
        await settle();
        button("next").click();
        await settle();
      },
      expected: { image: "nginx", restartPolicy: "no", cpuWeight: "normal" },
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
      expected: { image: "nginx", restartPolicy: "always", cpuWeight: "normal" },
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
        cpuWeight: "normal",
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
      expected: { image: "nginx", restartPolicy: "no", cpuWeight: "normal" },
    },
    {
      name: "the seven advanced fields the engine grew: privileged, capabilities, networks, labels, memory, CPU weight",
      fill: async () => {
        type("image", "nginx");
        button("privileged").click();
        await settle();
        button("next").click();
        await settle();
        button("add-label").click();
        await settle();
        type("label-name", "team");
        type("label-value", "infra");
        button("add-label").click();
        await settle();
        const names = document.querySelectorAll<HTMLInputElement>("[data-wizard-label-name]");
        const secondName = names[1];
        if (!secondName) {
          throw new Error("the second label row was not drawn");
        }
        secondName.value = "env";
        secondName.dispatchEvent(new Event("input", { bubbles: true }));
        const values = document.querySelectorAll<HTMLInputElement>("[data-wizard-label-value]");
        const secondValue = values[1];
        if (!secondValue) {
          throw new Error("the second label row was not drawn");
        }
        secondValue.value = "";
        secondValue.dispatchEvent(new Event("input", { bubbles: true }));
        // Capabilities: two of the common list.
        const checkboxes = [
          ...document.querySelectorAll<HTMLInputElement>(
            '[type="checkbox"][aria-label="NET_ADMIN"], [type="checkbox"][aria-label="SYS_CHROOT"]',
          ),
        ];
        if (checkboxes.length !== 2) {
          throw new Error(`expected the two capability checkboxes, drew ${checkboxes.length}`);
        }
        for (const box of checkboxes) {
          box.click();
        }
        // Networks, typed: no options were handed to the wizard in this mount.
        type("networks-text", "bridge, mem-net-test");
        await settle();
        button("memory-enabled").click();
        await settle();
        type("memory-limit", "512");
        await settle();
        button("next").click();
        await settle();
      },
      expected: {
        image: "nginx",
        restartPolicy: "no",
        privileged: true,
        capabilities: ["NET_ADMIN", "SYS_CHROOT"],
        networks: ["bridge", "mem-net-test"],
        labels: { team: "infra", env: "" },
        memoryLimitMb: 512,
        cpuWeight: "normal",
      },
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

  it("travels a read-only volume with its flag, and reads it back as ro on the review", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    button("add-volume").click();
    await settle();
    type("volume-host", "/data");
    type("volume-container", "/srv");
    await choose("Access", "Read only");
    await settle();

    button("next").click();
    await settle();
    const rows = [...document.querySelectorAll("[data-wizard-review-row]")].map((row) => row.textContent ?? "");
    expect(rows.find((row) => row.includes("/data"))).toContain("(ro)");

    button("create").click();
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock).toHaveBeenCalledWith("conn-1", {
      image: "nginx",
      restartPolicy: "no",
      volumes: [{ source: "/data", destination: "/srv", readOnly: true }],
      cpuWeight: "normal",
    });
  });

  it("carries the CPU weight the three steps name, the high one among them", async () => {
    await mount();

    type("image", "nginx");
    button("next").click();
    await settle();
    await choose("CPU weight", "High");
    await settle();

    button("next").click();
    await settle();
    button("create").click();
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock).toHaveBeenCalledWith("conn-1", {
      image: "nginx",
      restartPolicy: "no",
      cpuWeight: "high",
    });
  });

  it("lists the engine's networks as choices when the pane hands them over, and sends the ones ticked", async () => {
    await mount([
      { value: "bridge", label: "bridge" },
      { value: "mem-net-test", label: "mem-net-test" },
    ]);

    type("image", "nginx");
    button("next").click();
    await settle();

    // The engine's own list replaced the typed-names fallback: the networks card is checkboxes.
    const bridge = document.querySelector<HTMLInputElement>('input[type="checkbox"][aria-label="bridge"]');
    const typed = document.querySelector("[data-wizard-networks-text]");
    expect(bridge, "the engine's networks are choices").not.toBeNull();
    expect(typed, "the typed-names fallback is gone while the list is here").toBeNull();
    expect(bridge?.checked, "nothing is ticked to start with").toBe(false);

    (bridge as HTMLInputElement).click();
    await settle();
    button("next").click();
    await settle();
    button("create").click();
    await vi.waitFor(() => {
      expect(createMock).toHaveBeenCalled();
    });
    expect(createMock).toHaveBeenCalledWith("conn-1", {
      image: "nginx",
      restartPolicy: "no",
      networks: ["bridge"],
      cpuWeight: "normal",
    });
  });
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

describe("a clone ask", () => {
  it("writes the inspected fields over the blank form, and the copy starts unstarted", async () => {
    await mount(undefined, {
      name: "web-copy",
      image: "nginx:1.27",
      autostart: false,
      startNow: false,
      privileged: true,
      command: "",
      ports: [{ hostPort: "8080", containerPort: "80", protocol: "tcp" }],
      volumes: [{ hostPath: "/srv/site", containerPath: "/usr/share/html", readOnly: true }],
      env: [{ key: "NGINX_HOST", value: "example" }],
      labels: [{ name: "team", value: "edge" }],
      networks: ["bridge"],
      capabilities: [],
      cpuWeight: "high",
      memoryLimitMb: "256",
    });

    expect(field("image").value).toBe("nginx:1.27");
    expect(field("name").value).toBe("web-copy");
    // The copy is a sibling, not a twin: it does not start with the source.
    expect(document.querySelector("[data-wizard-start-now]")?.getAttribute("aria-checked")).toBe("false");

    button("next").click();
    await settle();
    expect(document.querySelector<HTMLInputElement>("[data-wizard-port-host]")?.value).toBe("8080");
  });
});
