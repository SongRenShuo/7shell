/**
 * The handover link the browser host opens the page with.
 *
 * What can only be seen here is the pair of shapes the two sides must agree on — the fragment
 * the shell writes and the reading this side does of it — and the one rule the link lives by: a
 * target the vault does not know is a notice and a quiet landing, never an error page.
 */

import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauri", () => ({
  sessionOpen: vi.fn(),
  sessionSystem: vi.fn(),
  terminalClose: vi.fn(),
  terminalWrite: vi.fn(),
  terminalResize: vi.fn(),
  knownHostTrust: vi.fn(),
  knownHostForget: vi.fn(),
  tunnelsOpen: vi.fn(),
  tunnelClose: vi.fn(),
  filesOpen: vi.fn(),
  filesOpenContainer: vi.fn(),
  filesOpenPod: vi.fn(),
  filesList: vi.fn(),
  filesClose: vi.fn(),
  transfersOpen: vi.fn(),
  desktopOpen: vi.fn(),
}));

vi.mock("@/lib/terminal/bus", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/terminal/bus")>();
  return {
    ...actual,
    startTerminalBus: vi.fn(async () => {}),
    onTerminalEnded: vi.fn(() => () => {}),
    endedTerminal: vi.fn(() => undefined),
  };
});

import { sessionOpen, sessionSystem } from "@/lib/backend/tauri";
import { consumeHandoverLink, handoverToken, parseHandoverFragment, resetHandoverForTest } from "@/lib/hosted/handover";
import { openHandoverTarget } from "@/lib/hosted/handoverOpen";
import { useNotificationsStore } from "@/stores/notifications";
import { useSessionsStore } from "@/stores/sessions";
import { useTerminalsStore } from "@/stores/terminals";
import type { Session } from "@/types/session";

const sessionOpenMock = vi.mocked(sessionOpen);
const sessionSystemMock = vi.mocked(sessionSystem);

/** A Linux desktop session, the shape a handover link is written for. */
function desktopSession(id: string): Session {
  return {
    id,
    name: `desk ${id}`,
    protocol: "linuxDesk",
    host: "lab.example.test",
    port: 22,
    user: "root",
    auth: { method: "password", hasSecret: true },
    terminal: {
      terminalType: "xterm-256color",
      keepaliveSeconds: 30,
      encoding: "utf-8",
      backspace: "del",
      forwardAgent: false,
      record: false,
    },
    updatedAt: 1_700_000_000,
  };
}

function writeHash(hash: string): void {
  window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
}

describe("the handover fragment", () => {
  beforeEach(() => {
    writeHash("");
  });

  afterEach(() => {
    writeHash("");
  });

  it("reads the token and the desktop target the shell wrote", () => {
    expect(parseHandoverFragment("#token=t-1&open=desktop:desk-01")).toEqual({
      token: "t-1",
      open: "desk-01",
    });
  });

  it("answers empty for a page opened without a fragment", () => {
    expect(parseHandoverFragment("")).toEqual({ token: null, open: null });
    expect(parseHandoverFragment("#")).toEqual({ token: null, open: null });
  });

  it("round-trips an id the writer had to encode", () => {
    // The same id and shape the shell's own URL test pins: characters that would end the
    // fragment or start another parameter arrive percent-encoded and come back as themselves.
    expect(parseHandoverFragment("#token=t&open=desktop:a%26b%3Dc%23d")).toEqual({
      token: "t",
      open: "a&b=c#d",
    });
  });

  it("leaves a literal plus in an id alone", () => {
    // Form-encoding would read `+` as a space; the writer does not encode it, so the reader must
    // not decode it as one.
    expect(parseHandoverFragment("#token=t&open=desktop:a+b").open).toBe("a+b");
  });

  it("passes an ordinary UUID id through untouched", () => {
    const id = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";
    expect(parseHandoverFragment(`#token=t&open=desktop:${id}`).open).toBe(id);
  });

  it("treats a target that is not a desktop as no target at all", () => {
    expect(parseHandoverFragment("#token=t&open=session:x").open).toBeNull();
    expect(parseHandoverFragment("#token=t").open).toBeNull();
  });
});

describe("the token the tab authenticates with", () => {
  beforeEach(() => {
    resetHandoverForTest("");
  });

  afterEach(() => {
    resetHandoverForTest("");
  });

  it("comes from the fragment the handover wrote, over the launcher's query", () => {
    writeHash("#token=fragment-token");
    expect(handoverToken()).toBe("fragment-token");
  });

  it("falls back to the query parameter the standalone launcher prints", () => {
    writeHash("");
    window.history.replaceState(null, "", `${window.location.pathname}?token=query-token`);
    expect(handoverToken()).toBe("query-token");
    window.history.replaceState(null, "", window.location.pathname);
  });
});

describe("the deep link's open target", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    sessionOpenMock.mockReset();
    sessionSystemMock.mockReset();
    sessionSystemMock.mockResolvedValue({ name: null, kernel: null, distro: null, distroLike: [] });
    writeHash("");
  });

  afterEach(() => {
    writeHash("");
  });

  it("opens the named session's desktop tab when the vault knows it", async () => {
    const library = useSessionsStore();
    library.sessions = [desktopSession("desk-01")];
    sessionOpenMock.mockResolvedValue({
      kind: "opened",
      sessionId: "desk-01",
      handle: "h-1",
      tunnels: [],
      tunnelFailures: [],
    });

    await openHandoverTarget("desk-01");

    const tabs = useTerminalsStore().tabs;
    expect(tabs).toHaveLength(1);
    expect(tabs[0]).toMatchObject({ kind: "workbench", handle: "h-1" });
    expect(useNotificationsStore().notices).toHaveLength(0);
  });

  it("reports a target the vault does not know and lands nowhere", async () => {
    useSessionsStore().sessions = [desktopSession("desk-01")];

    await openHandoverTarget("gone-01");

    expect(useTerminalsStore().tabs).toHaveLength(0);
    const notices = useNotificationsStore().notices;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.source).toBe("browser");
    expect(notices[0]?.titleKey).toBe("workbench.notices.deepLink.missing");
    expect(notices[0]?.params).toEqual({ id: "gone-01" });
  });

  it("does nothing for a link that carried no desktop", async () => {
    await openHandoverTarget(null);

    expect(useTerminalsStore().tabs).toHaveLength(0);
    expect(useNotificationsStore().notices).toHaveLength(0);
  });
});

describe("consuming the link", () => {
  beforeEach(() => {
    resetHandoverForTest("");
  });

  afterEach(() => {
    resetHandoverForTest("");
  });

  it("answers the target once and takes the fragment out of the address bar", () => {
    writeHash("#token=t-1&open=desktop:desk-01");

    expect(consumeHandoverLink()).toBe("desk-01");
    expect(window.location.hash).toBe("");
    // A second ask is the same link: one link, one open.
    expect(consumeHandoverLink()).toBeNull();
  });

  it("answers nothing when the page was opened without one", () => {
    expect(consumeHandoverLink()).toBeNull();
  });
});
