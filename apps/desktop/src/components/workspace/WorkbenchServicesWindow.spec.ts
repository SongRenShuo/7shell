/**
 * The desktop's services window: the host's listeners read as they are, and the two ways in.
 *
 * What can only be seen here: the rows are the overview's own listeners (and a host that answers
 * the older shape without the list at all draws the empty state, not an error — the Rust side
 * omits the list from the wire when empty, which is a fact about the host, not a broken read);
 * a process the reading account could not name is said so rather than invented; the tunnel button
 * opens a local forward from a free port here to the listener, narrowing a wide bind to the
 * loopback that actually answers; the browser button opens that tunnel and points this machine's
 * browser at the local end; and a refused open is an envelope sentence, not a console error.
 * The window's three states are checked in their own describe: the skeleton only for a first
 * read (a refresh never flashes it over live rows), the failure with its retry, and the empty
 * state whose way out is the forwards manager.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  systemOverview: vi.fn(),
  tunnelRuntimeOpen: vi.fn(),
  tunnelRuntimeStop: vi.fn(async () => {}),
  tunnelsOpen: vi.fn(async () => []),
  tunnelClose: vi.fn(async () => {}),
}));

import WorkbenchServicesWindow from "@/components/workspace/WorkbenchServicesWindow.vue";
import { useToast } from "@/composables/useToast";
import { i18n } from "@/i18n";
import { systemOverview, tunnelRuntimeOpen } from "@/lib/backend/tauri";
import type { SystemOverview } from "@/types/sysinfo";

const overviewMock = vi.mocked(systemOverview);
const openMock = vi.mocked(tunnelRuntimeOpen);

let app: App | undefined;
let host: HTMLDivElement | undefined;

/** A host that names two listeners, one of them under an account `ss` could not see into. */
const OVERVIEW: SystemOverview = {
  services: [],
  disks: [],
  accounts: [],
  interfaces: [],
  routes: [],
  dns: [],
  crontab: [],
  logins: [],
  mounts: [],
  uptimeSeconds: 60,
  listeners: [
    { port: 22, address: "0.0.0.0", process: "sshd" },
    { port: 3000, address: "127.0.0.1", process: "" },
  ],
};

async function mount(overview: Promise<SystemOverview>): Promise<void> {
  app?.unmount();
  host?.remove();
  overviewMock.mockReturnValue(overview);

  const pinia = createPinia();
  setActivePinia(pinia);
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () => h(WorkbenchServicesWindow, { sessionId: "session-1", handle: "w1", active: true }),
  });
  app.use(i18n);
  app.use(pinia);
  app.mount(host);
  await nextTick();
}

beforeEach(() => {
  overviewMock.mockReset();
  openMock.mockReset();
  useToast().visible.value = false;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
});

function windowBody(): HTMLElement {
  const body = document.querySelector<HTMLElement>("[data-workbench-services-window]");
  if (!body) {
    throw new Error("the services window was not drawn");
  }
  return body;
}

function rows(): HTMLElement[] {
  return [...windowBody().querySelectorAll<HTMLElement>("[data-workbench-services-row]")];
}

function button(label: string, scope: HTMLElement = windowBody()): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll<HTMLButtonElement>("button")].find((entry) =>
    entry.textContent?.trim().includes(label),
  );
}

describe("the desktop's services window", () => {
  it("draws every listener the host reported, with its process or the truth about the name", async () => {
    await mount(Promise.resolve(OVERVIEW));
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    expect(rows()[0]?.dataset.servicePort).toBe("22");
    expect(rows()[0]?.textContent).toContain("0.0.0.0:22");
    expect(rows()[0]?.textContent).toContain("sshd");
    // The second listener's process is one the reading account could not name; the row says so.
    expect(rows()[1]?.textContent).toContain("127.0.0.1:3000");
    expect(rows()[1]?.textContent).toContain("unnamed process");
  });

  it("draws the empty state for a host that answered without listeners, the older shape included", async () => {
    // A host that named no listener omits the key from the wire entirely; so does a host older
    // than this build's read. Both are "nothing to reach", not a failure.
    const { listeners: _omitted, ...withoutListeners } = OVERVIEW;
    await mount(Promise.resolve(withoutListeners as SystemOverview));
    await nextTick();

    expect(windowBody().querySelector("[data-workbench-services-empty]")?.textContent).toContain(
      "did not report any listening ports",
    );
    expect(rows().length).toBe(0);
    expect(overviewMock).toHaveBeenCalledWith("w1");
  });

  it("opens a tunnel from a free port here to the listener, narrowing a wide bind to the loopback", async () => {
    openMock.mockResolvedValue({
      id: "t-new",
      handle: "handle-1",
      sessionId: "session-1",
      bindHost: "127.0.0.1",
      bindPort: 41233,
      mode: "local",
      targetHost: "127.0.0.1",
      targetPort: 22,
      connections: 0,
    });
    await mount(Promise.resolve(OVERVIEW));
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    button("Open a tunnel", rows()[0] as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(openMock).toHaveBeenCalledWith(
        "session-1",
        {
          mode: "local",
          bindHost: "127.0.0.1",
          bindPort: 0,
          // The host printed 0.0.0.0; what the tunnel dials is the loopback that answers on it.
          targetHost: "127.0.0.1",
          targetPort: 22,
        },
        false,
      );
    });
    await vi.waitFor(() => {
      expect(useToast().message.value).toContain("41233");
    });
  });

  it("opens the browser at the local end of the tunnel it just asked for", async () => {
    openMock.mockResolvedValue({
      id: "t-web",
      handle: "handle-1",
      sessionId: "session-1",
      bindHost: "127.0.0.1",
      bindPort: 43333,
      mode: "local",
      targetHost: "127.0.0.1",
      targetPort: 3000,
      connections: 0,
    });
    const openSpy = vi.spyOn(window, "open").mockReturnValue(null);
    try {
      await mount(Promise.resolve(OVERVIEW));
      await vi.waitFor(() => {
        expect(rows().length).toBe(2);
      });

      button("Open in browser", rows()[1] as HTMLElement)?.click();
      await vi.waitFor(() => {
        expect(openMock).toHaveBeenCalledWith(
          "session-1",
          {
            mode: "local",
            bindHost: "127.0.0.1",
            bindPort: 0,
            targetHost: "127.0.0.1",
            targetPort: 3000,
          },
          false,
        );
      });
      await vi.waitFor(() => {
        expect(openSpy).toHaveBeenCalledWith("http://127.0.0.1:43333", "_blank", "noopener,noreferrer");
      });
    } finally {
      openSpy.mockRestore();
    }
  });

  it("says why when an open was refused, in the envelope's own sentence", async () => {
    openMock.mockRejectedValue({
      version: 1,
      code: "POLICY-DENIED",
      messageKey: "errors.policy.denied",
      messageParams: { action: "tunnel.open" },
      origin: { subsystem: "policy" },
      outcome: "refused",
    });
    await mount(Promise.resolve(OVERVIEW));
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });

    button("Open a tunnel", rows()[0] as HTMLElement)?.click();
    await vi.waitFor(() => {
      expect(windowBody().textContent).toContain("POLICY-DENIED");
    });
    // The buttons come back out of their busy state, so the next ask is possible.
    expect(button("Open a tunnel", rows()[0] as HTMLElement)?.disabled).toBe(false);
  });

  it("says why when the read failed, in the envelope's own sentence", async () => {
    overviewMock.mockRejectedValue({
      version: 1,
      code: "SESSION-CLOSED",
      messageKey: "errors.session.closed",
      messageParams: {},
      origin: { subsystem: "session" },
      outcome: "failed",
    });
    await mount(
      new Promise<SystemOverview>((_, reject) => {
        reject({
          version: 1,
          code: "SESSION-CLOSED",
          messageKey: "errors.session.closed",
          messageParams: {},
          origin: { subsystem: "session" },
          outcome: "failed",
        });
      }),
    );
    await vi.waitFor(() => {
      expect(windowBody().textContent).toContain("SESSION-CLOSED");
    });
    expect(rows().length).toBe(0);
  });
});

describe("the services window's three states", () => {
  it("draws the rows' skeleton for the first read, and nothing else — no empty state behind a promise", async () => {
    // A host that has not answered yet: the shape of what is coming, and neither the empty state
    // (which would claim the host has no listeners) nor blankness (which reads as broken).
    await mount(new Promise<SystemOverview>(() => {}));

    expect(document.querySelector("[data-workbench-services-skeleton]")).not.toBeNull();
    expect(document.querySelector("[data-workbench-services-empty]")).toBeNull();
    expect(rows().length).toBe(0);
  });

  it("the skeleton is only for the first read: a refresh over live rows keeps the rows on screen", async () => {
    let arrive!: (overview: SystemOverview) => void;
    await mount(
      new Promise<SystemOverview>((resolve) => {
        arrive = resolve;
      }),
    );
    expect(document.querySelector("[data-workbench-services-skeleton]")).not.toBeNull();

    // The answer lands and the skeleton steps aside in the same render — no flash between.
    arrive(OVERVIEW);
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    expect(document.querySelector("[data-workbench-services-skeleton]")).toBeNull();

    // A second, slow read: the rows stay drawn, so nothing flashes over what was already there.
    overviewMock.mockReturnValue(new Promise<SystemOverview>(() => {}));
    button("Refresh")?.click();
    await nextTick();
    expect(document.querySelector("[data-workbench-services-skeleton]")).toBeNull();
    expect(rows().length).toBe(2);
  });

  it("a failed read is the banner with the retry beside it, not the empty state", async () => {
    await mount(
      Promise.reject({
        version: 1,
        code: "SESSION-CLOSED",
        messageKey: "errors.session.closed",
        messageParams: {},
        origin: { subsystem: "session" },
        outcome: "failed",
      }),
    );
    await vi.waitFor(() => {
      expect(windowBody().textContent).toContain("SESSION-CLOSED");
    });

    // A failed read is not an empty host: the empty state stays hidden, the retry stands.
    expect(document.querySelector("[data-workbench-services-empty]")).toBeNull();
    overviewMock.mockReturnValue(Promise.resolve(OVERVIEW));
    button("Retry")?.click();
    await vi.waitFor(() => {
      expect(rows().length).toBe(2);
    });
    expect(windowBody().textContent).not.toContain("SESSION-CLOSED");
  });

  it("the empty state's way out is the forwards manager, and the window says so", async () => {
    const { listeners: _omitted, ...withoutListeners } = OVERVIEW;
    let openedForwards = 0;
    app?.unmount();
    host?.remove();

    const pinia = createPinia();
    setActivePinia(pinia);
    overviewMock.mockReturnValue(Promise.resolve(withoutListeners as SystemOverview));
    host = document.createElement("div");
    document.body.append(host);
    app = createApp({
      render: () =>
        h(WorkbenchServicesWindow, {
          sessionId: "session-1",
          handle: "w1",
          active: true,
          onOpenForwards: () => {
            openedForwards += 1;
          },
        }),
    });
    app.use(i18n);
    app.use(pinia);
    app.mount(host);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-workbench-services-empty]")).not.toBeNull();
    });

    const wayOut = document.querySelector<HTMLButtonElement>("[data-workbench-services-open-forwards]");
    expect(wayOut?.textContent?.trim()).toBe("Open the forwards manager");
    wayOut?.click();
    await nextTick();
    expect(openedForwards).toBe(1);
  });
});
