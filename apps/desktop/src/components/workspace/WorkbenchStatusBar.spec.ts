/**
 * The strip along the top of the desktop, as a person reads it: which machine, who is on it, what
 * time it is, and the one way out.
 *
 * What can only be seen here is the handover — that the three readings arrive unchanged and that the
 * button asks the owner to disconnect rather than deciding anything itself. The component owns no
 * clock and no session, so a wrong reading here would mean the owner is wrong; a missing emission
 * would mean a button that looks live and does nothing.
 */
import { type App, createApp, defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import WorkbenchStatusBar from "@/components/workspace/WorkbenchStatusBar.vue";

const HOST = "lab.example.test:2222";
const USER = "root";
const CLOCK = "14:32";

let disconnects = 0;
let app: App | undefined;
let root: HTMLDivElement | undefined;

/** Mounts the strip over one session, connected unless the case says otherwise. */
function mount(connected = true): void {
  disconnects = 0;
  const Host = defineComponent({
    setup() {
      return () =>
        h(WorkbenchStatusBar, {
          host: HOST,
          user: USER,
          clock: CLOCK,
          connected,
          labels: { disconnect: "Disconnect" },
          onDisconnect: () => {
            disconnects += 1;
          },
        });
    },
  });

  app = createApp(Host);
  root = document.createElement("div");
  document.body.append(root);
  app.mount(root);
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  root?.remove();
  root = undefined;
  document.body.innerHTML = "";
});

function part(name: string): HTMLElement {
  const element = document.querySelector(`[data-workbench-status-${name}]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`the status bar has no ${name} part`);
  }
  return element;
}

function disconnectButton(): HTMLButtonElement {
  const element = part("disconnect");
  if (!(element instanceof HTMLButtonElement)) {
    throw new Error("the disconnect control is not a button");
  }
  return element;
}

describe("the strip along the top of the desktop", () => {
  it("names the machine, the account and the time it was handed", () => {
    expect(part("host").textContent).toBe(HOST);
    expect(part("user").textContent).toBe(USER);
    expect(part("clock").textContent).toBe(CLOCK);
  });

  it("draws the machine in the monospace face the reference uses", () => {
    expect(part("host").classList.contains("font-mono")).toBe(true);
  });

  it("asks the owner to disconnect when the power control is pressed", () => {
    disconnectButton().dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(disconnects).toBe(1);
  });

  it("names the disconnect control for a screen reader", () => {
    expect(disconnectButton().getAttribute("aria-label")).toBe("Disconnect");
  });

  it("disables the control on a session that is already gone", () => {
    app?.unmount();
    document.body.innerHTML = "";
    mount(false);

    expect(disconnectButton().disabled).toBe(true);
  });
});
