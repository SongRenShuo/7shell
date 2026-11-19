/**
 * The browser page's leave guard, as its reader meets it.
 *
 * What can only be seen here is the pair of hosts the guard lives between: in a browser, bytes
 * still moving turn a tab close into a question, and bytes done moving turn it back into a close;
 * in the desktop shell the guard registers nothing, because the pane's own guard owns that window's
 * leave.
 */

import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => false) }));
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

import { isDesktopRuntime } from "@/lib/runtime";
import { i18n } from "@/i18n";
import { useFilesStore } from "@/stores/files";
import type { TransferInfo } from "@/types/session";
import { useBrowserLeaveGuard } from "./useBrowserLeaveGuard";

const isDesktopRuntimeMock = vi.mocked(isDesktopRuntime);

/** One transfer, moving or in whatever state the case asks about. */
function transfer(kind: TransferInfo["state"]["kind"]): TransferInfo {
  return {
    id: "t1",
    direction: "upload",
    name: "backup.tar",
    remotePath: "/root/backup.tar",
    sessionId: "desk-1",
    size: 100,
    transferred: 0,
    state: kind === "failed" ? { kind: "failed", detail: "broken" } : { kind },
    hasLocalPath: false,
    packed: false,
    pausable: true,
  };
}

let app: App | undefined;
let host: HTMLDivElement | undefined;

/** Mounts a page that registers the guard, the way the shell's own frame does. */
function mountGuard(): void {
  const Host = defineComponent({
    setup() {
      useBrowserLeaveGuard();
      return () => h("div");
    },
  });
  app = createApp(Host);
  app.use(createPinia());
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
}

function leaveEvent(): Event {
  return new Event("beforeunload", { cancelable: true });
}

beforeEach(() => {
  isDesktopRuntimeMock.mockReturnValue(false);
  setActivePinia(createPinia());
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

describe("the browser page's leave guard", () => {
  it("asks before the tab goes away while bytes are still moving", () => {
    mountGuard();
    useFilesStore().transfers = [transfer("running")];

    const event = leaveEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented, "a transfer a closed tab abandons is one nobody can stop").toBe(true);
    expect((event as BeforeUnloadEvent).returnValue).toBe("Uploads are still running. Leaving now abandons them.");
  });

  it("lets the tab go when nothing is moving", () => {
    mountGuard();
    useFilesStore().transfers = [transfer("done")];

    const event = leaveEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it("lets a paused transfer go, which is the desktop's own guard's call too", () => {
    mountGuard();
    useFilesStore().transfers = [transfer("paused")];

    const event = leaveEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented, "the semantics are the desktop guard's, reused whole: only moving bytes ask").toBe(
      false,
    );
  });

  it("stops asking once it is unmounted with its page", () => {
    mountGuard();
    useFilesStore().transfers = [transfer("running")];
    app?.unmount();
    app = undefined;

    const event = leaveEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented, "the guard lived with the page, and the page is gone").toBe(false);
  });

  it("registers nothing in the desktop shell, whose pane owns that window's guard", () => {
    isDesktopRuntimeMock.mockReturnValue(true);
    mountGuard();
    useFilesStore().transfers = [transfer("running")];

    const event = leaveEvent();
    window.dispatchEvent(event);

    expect(event.defaultPrevented, "one leave, one question — and this is not the guard for it").toBe(false);
  });
});
