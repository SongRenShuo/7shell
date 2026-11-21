/**
 * The desktop's forwards window, as it is met: the live list, the one stop behind a question, and
 * the add form that speaks in scenes.
 *
 * The forward engine and its policy gate live on the far side; what is checked here is what the
 * window adds — that the list is the backend's own reading, that stopping a runtime forward is
 * asked about once and really asked for, that an added forward's answer (with the port actually
 * bound) joins the list, and that a session without a connection forwards can ride on is refused
 * in a sentence rather than drawn as an empty room. The rows carry the desktop's status lights —
 * filled green is a tunnel carrying a connection, hollow is up but idle — and the empty state's
 * one action hands the caret to the add form, while a failed read offers the retry in its banner.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  tunnelsOpen: vi.fn(),
  tunnelClose: vi.fn(async () => {}),
  tunnelRuntimeOpen: vi.fn(),
  tunnelRuntimeStop: vi.fn(async () => {}),
  // The sessions store's reads ride the same module; the window needs only the library itself.
  sessionsGet: vi.fn(async () => ({ sessions: [] })),
  sessionGroupsGet: vi.fn(async () => ({ groups: [] })),
  knownHostsList: vi.fn(async () => []),
}));

import WorkbenchForwardsWindow from "@/components/workspace/WorkbenchForwardsWindow.vue";
import { i18n } from "@/i18n";
import { ShellError } from "@/lib/backend/errors";
import { tunnelRuntimeOpen, tunnelRuntimeStop, tunnelsOpen } from "@/lib/backend/tauri";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { OpenTunnel, Session } from "@/types/session";

const listMock = vi.mocked(tunnelsOpen);
const openMock = vi.mocked(tunnelRuntimeOpen);
const stopMock = vi.mocked(tunnelRuntimeStop);

let app: App | undefined;
let host: HTMLDivElement | undefined;

function tunnel(id: string, mode: "local" | "dynamic" | "remote" = "local"): OpenTunnel {
  return {
    id,
    handle: "handle-1",
    sessionId: "session-1",
    bindHost: "127.0.0.1",
    bindPort: 20000 + id.length,
    mode,
    targetHost: mode === "dynamic" ? "" : "db.internal",
    targetPort: mode === "dynamic" ? 0 : 5432,
    connections: 2,
  };
}

function session(protocol: Session["protocol"]): Session {
  return {
    id: "session-1",
    name: "lab",
    protocol,
    host: "lab.test",
    port: 22,
    user: "root",
    auth: { method: "password", hasSecret: true },
    terminal: {
      terminalType: "xterm-256color",
      keepaliveSeconds: 0,
      encoding: "utf-8",
      backspace: "del",
      forwardAgent: false,
      record: false,
    },
    updatedAt: 0,
  };
}

async function mount(protocol: Session["protocol"] | null): Promise<void> {
  app?.unmount();
  host?.remove();

  const pinia = createPinia();
  setActivePinia(pinia);
  const library = useSessionsStore();
  if (protocol !== null) {
    library.sessions = [session(protocol)];
  }
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () => h(WorkbenchForwardsWindow, { sessionId: "session-1" }),
  });
  app.use(i18n);
  app.use(pinia);
  app.mount(host);
  await nextTick();
}

beforeEach(() => {
  listMock.mockReset().mockResolvedValue([]);
  openMock.mockReset();
  stopMock.mockClear();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function windowBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-workbench-forwards-window]");
  if (!body) {
    throw new Error("the forwards window was not drawn");
  }
  return body;
}

function rows(): HTMLElement[] {
  return [...windowBody().querySelectorAll<HTMLElement>("[data-workbench-forwards-row]")];
}

function button(label: string): HTMLButtonElement | undefined {
  return [...document.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    entry.textContent?.trim().includes(label),
  );
}

/** Types into a field the way a person does: the value and the event the v-model listens for. */
function type(input: HTMLInputElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event("input"));
}

/** The dropdown, driven the way reka-ui answers: the pointer down, then the pointer released. */
async function chooseMode(label: string): Promise<void> {
  const trigger = [...windowBody().querySelectorAll<HTMLElement>("[role='combobox']")].find(() => true);
  if (!trigger) {
    throw new Error("the mode dropdown drew no trigger");
  }
  trigger.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
  trigger.click();
  await nextTick();
  await nextTick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const option = [...document.querySelectorAll<HTMLElement>("[role='option']")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!option) {
    throw new Error(`the mode dropdown has no option called ${label}`);
  }
  option.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
  await nextTick();
  await nextTick();
  // The list lives on the body; take it away so a later test finds no stray options.
  for (const element of document.querySelectorAll("[role='listbox']")) {
    element.remove();
  }
}

describe("the desktop's forwards window", () => {
  it("reads the live list and draws every forward, with SOCKS5 where a dynamic one has no destination", async () => {
    listMock.mockResolvedValue([tunnel("t1"), tunnel("t2", "dynamic")]);
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    expect(rows()[0]?.textContent).toContain("db.internal:5432");
    expect(rows()[1]?.textContent).toContain("SOCKS5");
    expect(windowBody().textContent).toContain("2 connections carried");
  });

  it("a session without a connection forwards can ride on is refused in a sentence", async () => {
    await mount("telnet");

    expect(windowBody().textContent).toContain("cannot be hosted");
    expect(listMock).not.toHaveBeenCalled();
    expect(rows().length).toBe(0);
  });

  it("a local forward is added in the scene the form names, and the answer joins the list", async () => {
    await mount("ssh");
    await nextTick();

    const body = windowBody().querySelector<HTMLElement>("[data-workbench-forwards-add]");
    expect(body).not.toBeNull();
    // The scenario sentences, so "local forward" names something rather than a pair of fields.
    expect(body?.textContent).toContain("127.0.0.1:25433");

    const [bindHost, bindPort, targetHost, targetPort] = [
      ...windowBody().querySelectorAll<HTMLInputElement>("input[type='text']"),
    ];
    if (!bindHost || !bindPort || !targetHost || !targetPort) {
      throw new Error("the add form was not drawn in full");
    }
    bindHost.value = "127.0.0.1";
    type(bindPort, "25432");
    type(targetHost, "127.0.0.1");
    type(targetPort, "25433");
    // The bindings land synchronously; the button's own face is updated on the next render.
    await nextTick();

    openMock.mockResolvedValue({
      id: "t-new",
      handle: "handle-1",
      sessionId: "session-1",
      bindHost: "127.0.0.1",
      bindPort: 25432,
      mode: "local",
      targetHost: "127.0.0.1",
      targetPort: 25433,
      connections: 0,
    });

    const add = button("Add forward");
    expect(add).not.toBeUndefined();
    expect(add?.disabled).toBe(false);
    // The form's own submit event, which jsdom does not fire from the button's click alone.
    windowBody()
      .querySelector<HTMLFormElement>("[data-workbench-forwards-add]")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "session-1",
        {
          mode: "local",
          bindHost: "127.0.0.1",
          bindPort: 25432,
          targetHost: "127.0.0.1",
          targetPort: 25433,
        },
        false,
      );
    });
    await vi.waitFor(() => {
      expect(rows().some((row) => row.textContent?.includes("25432"))).toBe(true);
    });
  });

  it("a port of 0 asks for a free one, and the answer carries the port that was actually bound", async () => {
    await mount("ssh");
    await nextTick();

    const [bindHost, bindPort, targetHost, targetPort] = [
      ...windowBody().querySelectorAll<HTMLInputElement>("input[type='text']"),
    ];
    if (!bindHost || !bindPort || !targetHost || !targetPort) {
      throw new Error("the add form was not drawn in full");
    }
    bindHost.value = "127.0.0.1";
    type(bindPort, "0");
    type(targetHost, "127.0.0.1");
    type(targetPort, "25433");
    await nextTick();

    openMock.mockResolvedValue({
      id: "t-free",
      handle: "handle-1",
      sessionId: "session-1",
      bindHost: "127.0.0.1",
      bindPort: 41233,
      mode: "local",
      targetHost: "127.0.0.1",
      targetPort: 25433,
      connections: 0,
    });

    button("Add forward")?.click();
    windowBody()
      .querySelector<HTMLFormElement>("[data-workbench-forwards-add]")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "session-1",
        {
          mode: "local",
          bindHost: "127.0.0.1",
          bindPort: 0,
          targetHost: "127.0.0.1",
          targetPort: 25433,
        },
        false,
      );
    });
    // What is up is the port that was actually bound, not the 0 that asked for it.
    await vi.waitFor(() => {
      expect(rows().some((row) => row.textContent?.includes("41233"))).toBe(true);
    });
  });

  it("the destination fields are not asked for a dynamic forward", async () => {
    await mount("ssh");
    await nextTick();

    const inputs = windowBody().querySelectorAll<HTMLInputElement>("input[type='text']");
    // Listen address, listen port, destination host, destination port.
    expect(inputs.length).toBe(4);

    await chooseMode("Dynamic (SOCKS5)");

    expect(windowBody().querySelectorAll<HTMLInputElement>("input[type='text']").length).toBe(2);
  });

  it("stopping a forward is asked about once, and the ask really stops it", async () => {
    listMock.mockResolvedValue([tunnel("t1")]);
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(rows().length).toBe(1);
    });

    const stop = [...(rows()[0]?.querySelectorAll("button") ?? [])].find((entry) => entry !== null);
    stop?.click();
    await nextTick();

    // The question, said once: the button names the same verb the row did.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (entry) => entry.textContent?.trim() === "Stop forward",
    );
    expect(confirm).not.toBeUndefined();
    confirm?.click();

    await vi.waitFor(() => {
      expect(stopMock).toHaveBeenCalledWith("t1");
    });
    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
  });

  it("draws a remote forward with its kind named and the arrow pointing home, at the service on this machine", async () => {
    listMock.mockResolvedValue([tunnel("t1", "remote")]);
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(rows().length).toBe(1);
    });

    const row = rows()[0];
    expect(row?.dataset.forwardMode).toBe("remote");
    expect(row?.textContent).toContain("remote");
    // The destination is read the other way: the service this machine answers with.
    expect(row?.textContent).toContain("db.internal:5432");
    const arrow = row?.querySelector<SVGElement>("[role='img']");
    expect(arrow?.getAttribute("aria-label")).toBe("Exposed by this machine");
  });

  it("a remote forward is added with the fields read backwards, and the answer joins the list", async () => {
    await mount("ssh");
    await nextTick();

    await chooseMode("Remote");

    // The destination fields stay — a remote forward needs them, read in its own direction.
    expect(windowBody().querySelectorAll<HTMLInputElement>("input[type='text']").length).toBe(4);

    const [bindHost, bindPort, targetHost, targetPort] = [
      ...windowBody().querySelectorAll<HTMLInputElement>("input[type='text']"),
    ];
    if (!bindHost || !bindPort || !targetHost || !targetPort) {
      throw new Error("the add form was not drawn in full");
    }
    bindHost.value = "127.0.0.1";
    type(bindPort, "18080");
    type(targetHost, "127.0.0.1");
    type(targetPort, "8080");
    await nextTick();

    openMock.mockResolvedValue({
      id: "t-remote",
      handle: "handle-1",
      sessionId: "session-1",
      bindHost: "127.0.0.1",
      bindPort: 18080,
      mode: "remote",
      targetHost: "127.0.0.1",
      targetPort: 8080,
      connections: 0,
    });

    windowBody()
      .querySelector<HTMLFormElement>("[data-workbench-forwards-add]")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "session-1",
        {
          mode: "remote",
          bindHost: "127.0.0.1",
          bindPort: 18080,
          targetHost: "127.0.0.1",
          targetPort: 8080,
        },
        false,
      );
    });
    await vi.waitFor(() => {
      expect(rows().some((row) => row.dataset.forwardMode === "remote")).toBe(true);
    });
  });

  it("a forward the gate stops for is asked about here, and the answer rides the resend", async () => {
    await mount("ssh");
    await nextTick();

    await chooseMode("Remote");
    const [bindHost, bindPort, targetHost, targetPort] = [
      ...windowBody().querySelectorAll<HTMLInputElement>("input[type='text']"),
    ];
    if (!bindHost || !bindPort || !targetHost || !targetPort) {
      throw new Error("the add form was not drawn in full");
    }
    bindHost.value = "127.0.0.1";
    type(bindPort, "18080");
    type(targetHost, "127.0.0.1");
    type(targetPort, "8080");
    await nextTick();

    // The gate's refusal, shaped the way the shell sends it: the rule that fired named in the
    // action parameter. Under the default matrix a remote forward always stops here.
    const wantsAPerson = new ShellError({
      version: 1,
      code: "POLICY-APPROVAL-REQUIRED",
      messageKey: "errors.policy.approvalRequired",
      messageParams: { action: "tunnel.remote" },
      origin: { subsystem: "policy" },
      outcome: "rejected",
    });
    openMock.mockRejectedValueOnce(wantsAPerson);
    openMock.mockResolvedValue({
      id: "t-remote-2",
      handle: "handle-1",
      sessionId: "session-1",
      bindHost: "127.0.0.1",
      bindPort: 18080,
      mode: "remote",
      targetHost: "127.0.0.1",
      targetPort: 8080,
      connections: 0,
    });

    windowBody()
      .querySelector<HTMLFormElement>("[data-workbench-forwards-add]")
      ?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledTimes(1);
    });
    // The question is on screen, nothing further has been sent, and the list has not grown.
    await vi.waitFor(() => {
      expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    });
    expect(document.body.textContent).toContain("remote forward");
    expect(rows().length).toBe(0);

    // The answer travels: the resend carries the acknowledgement, and the forward joins the list.
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].find(
      (candidate) => candidate.textContent?.trim() === "Open",
    );
    if (!confirm) {
      throw new Error("the open question had no confirm button");
    }
    confirm.click();
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledTimes(2);
    });
    expect(openMock).toHaveBeenLastCalledWith(
      "session-1",
      {
        mode: "remote",
        bindHost: "127.0.0.1",
        bindPort: 18080,
        targetHost: "127.0.0.1",
        targetPort: 8080,
      },
      true,
    );
    await vi.waitFor(() => {
      expect(rows().length).toBe(1);
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("re-reads the list when forwards change elsewhere, without anybody pressing refresh", async () => {
    listMock.mockResolvedValue([tunnel("t1")]);
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(rows().length).toBe(1);
    });
    expect(listMock).toHaveBeenCalledTimes(1);

    // A terminal on this session brought another forward up: the store learned, the window follows.
    listMock.mockResolvedValue([tunnel("t1"), tunnel("t2")]);
    const terminals = useTerminalsStore();
    terminals.tunnels = [tunnel("t1"), tunnel("t2")];

    await vi.waitFor(() => {
      expect(listMock).toHaveBeenCalledTimes(2);
    });
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    // One stopped somewhere else leaves the reading too, not just new arrivals.
    listMock.mockResolvedValue([tunnel("t1")]);
    terminals.tunnels = [tunnel("t1")];
    await vi.waitFor(() => {
      expect(rows().length).toBe(1);
    });
  });
});

describe("the forwards window's rows and empty state", () => {
  it("wears the status light: filled green while carrying a connection, hollow while idle", async () => {
    const idle = { ...tunnel("t3"), connections: 0 };
    listMock.mockResolvedValue([tunnel("t1"), idle]);
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    const lights = [...windowBody().querySelectorAll<HTMLElement>("[data-workbench-forwards-light]")];
    expect(lights.length).toBe(2);
    // The tunnel carrying two connections: filled, in the theme's success token.
    expect(rows()[0]?.dataset.forwardCarrying).toBe("yes");
    expect(lights[0]?.className).toContain("bg-success");
    expect(lights[0]?.className).not.toContain("border");
    // The tunnel up but carrying nothing: hollow, in the muted voice.
    expect(rows()[1]?.dataset.forwardCarrying).toBe("no");
    expect(lights[1]?.className).toContain("border");
    expect(lights[1]?.className).not.toContain("bg-success");
  });

  it("the empty state's way out is the add form, and the failure banner carries the retry", async () => {
    // Empty, and the action hands the caret to the form — the form is the way out.
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(windowBody().querySelector("[data-workbench-forwards-empty]")).not.toBeNull();
    });
    windowBody().querySelector<HTMLButtonElement>("[data-workbench-forwards-empty-add]")?.click();
    await nextTick();
    const firstField = windowBody().querySelector<HTMLInputElement>("[data-workbench-forwards-add] input");
    expect(firstField).not.toBeNull();
    expect(document.activeElement).toBe(firstField);

    // A read that failed: the banner names it and offers the retry beside the dismiss.
    listMock.mockReset().mockRejectedValue(
      new ShellError({
        version: 1,
        code: "SESSION-CLOSED",
        messageKey: "errors.session.closed",
        messageParams: {},
        origin: { subsystem: "terminal" },
        outcome: "unknown",
      }),
    );
    await mount("linuxDesk");
    await vi.waitFor(() => {
      expect(windowBody().textContent).toContain("SESSION-CLOSED");
    });
    expect(windowBody().querySelector("[data-workbench-forwards-empty]")).toBeNull();

    // The retry is the same read again, now answered: the list arrives, the banner goes.
    listMock.mockReset().mockResolvedValue([tunnel("t1")]);
    button("Retry")?.click();
    await vi.waitFor(() => {
      expect(rows().length).toBe(1);
    });
    expect(windowBody().textContent).not.toContain("SESSION-CLOSED");
  });
});
