/**
 * The stub a hosted desktop tab draws, as its reader meets it.
 *
 * What can only be seen here is the stub's whole content — the URL the handover opened, the copy,
 * the "take the URL again" that answers for a host that stopped itself, the take-back — and the one
 * promise the card lives by: it writes nothing of the desktop's own memory, because the pane under
 * it is only parked, not gone.
 */

import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h } from "vue";
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
  desktopBrowserOpen: vi.fn(),
  desktopBrowserUrl: vi.fn(),
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

import { desktopBrowserOpen, desktopBrowserUrl } from "@/lib/backend/tauri";
import { useToast } from "@/composables/useToast";
import { i18n } from "@/i18n";
import { readWindowMemory } from "@/lib/workbench/windowMemory";
import WorkbenchHostedCard from "@/components/workspace/WorkbenchHostedCard.vue";
import { type WorkbenchTab, useTerminalsStore } from "@/stores/terminals";
import type { Session } from "@/types/session";

const desktopBrowserOpenMock = vi.mocked(desktopBrowserOpen);
const desktopBrowserUrlMock = vi.mocked(desktopBrowserUrl);

const FIRST_URL = "http://127.0.0.1:4225/#token=t-1&open=desktop:desk-1";
const SECOND_URL = "http://127.0.0.1:51777/#token=t-2&open=desktop:desk-1";
/** The key the desktop's window memory lives under; the stub must never write it. */
const WINDOW_MEMORY_KEY = "sevenshell-workbench-window-memory-v1";

/** A Linux desktop session, the shape a handover is about. */
function deskSession(): Session {
  return {
    id: "desk-1",
    name: "lab desk",
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

/** The workbench tab the stub stands in for. */
function hostedTab(): WorkbenchTab {
  return { kind: "workbench", id: "wb-1", session: deskSession(), handle: "h-1", failure: null };
}

let app: App | undefined;
let host: HTMLDivElement | undefined;

/**
 * Mounts the stub over one hosted session: the workspace store already holds the tab and the URL
 * the handover opened, and the card is drawn exactly as the tab strip draws it — over the same
 * store, so what it reads and what it changes are the store's own facts.
 */
async function mountCard(): Promise<{ tab: WorkbenchTab; store: ReturnType<typeof useTerminalsStore> }> {
  const pinia = createPinia();
  setActivePinia(pinia);
  const store = useTerminalsStore();
  const tab = hostedTab();
  store.tabs = [tab];
  desktopBrowserOpenMock.mockResolvedValue(FIRST_URL);
  await store.hostInBrowser(tab.id);

  app = createApp({
    render() {
      return h(WorkbenchHostedCard, { tab });
    },
  });
  app.use(pinia);
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  return { tab, store };
}

beforeEach(() => {
  desktopBrowserOpenMock.mockReset();
  desktopBrowserUrlMock.mockReset();
  localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  document.body.innerHTML = "";
  delete (navigator as unknown as { clipboard?: unknown }).clipboard;
});

function part(name: string): HTMLElement {
  const element = document.querySelector(`[data-workbench-hosted-${name}]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`the stub has no ${name} part`);
  }
  return element;
}

describe("the stub a hosted desktop draws", () => {
  it("says which desktop is hosted and draws the URL the handover opened", async () => {
    await mountCard();

    expect(part("title").textContent).toContain("lab desk");
    const link = part("link");
    expect(link.getAttribute("href")).toBe(FIRST_URL);
    expect(link.textContent).toBe(FIRST_URL);
  });

  it("carries the hosted explanation, and the two moves the stub owns", async () => {
    await mountCard();

    expect(part("explanation").textContent).not.toBe("");
    expect(part("refresh").textContent).toContain("Take the URL again");
    expect(part("take-back").textContent).toContain("Take back into the app");
  });

  it("copies the URL and says which of the two things happened", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mountCard();

    part("copy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(FIRST_URL));

    const { message, tier } = useToast();
    expect(message.value).toBe("The URL is on the clipboard.");
    expect(tier.value).toBe("receipt");
  });

  it("says so when the clipboard refused", async () => {
    const writeText = vi.fn(async () => {
      throw new Error("refused");
    });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await mountCard();

    part("copy").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(useToast().tier.value).toBe("failure"));
  });

  it("taking the URL again shows what comes back now, not what was remembered", async () => {
    desktopBrowserUrlMock.mockResolvedValue(SECOND_URL);
    const { tab } = await mountCard();

    part("refresh").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await vi.waitFor(() => expect(part("link").getAttribute("href")).toBe(SECOND_URL));
    expect(desktopBrowserUrlMock).toHaveBeenCalledWith(tab.session.id);
  });

  it("taking the desktop back clears the hosted state, and the handle was never touched", async () => {
    const { tab, store } = await mountCard();

    part("take-back").dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(store.hostedUrl(tab.session.id)).toBeNull();
    expect(tab.handle, "the connection stays with the application").toBe("h-1");
  });

  it("writes nothing to the desktop's own window memory", async () => {
    await mountCard();
    app?.unmount();
    app = undefined;

    expect(localStorage.getItem(WINDOW_MEMORY_KEY), "the stub is a reader, never a writer").toBeNull();
    expect(readWindowMemory("desk-1")).toEqual({});
  });
});
