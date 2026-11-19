/**
 * The system panel's service verbs, as they reach the shell: what the panel asks about it answers
 * for, and what it does not ask about it sends unacknowledged.
 *
 * The verbs are `Caution` and simply run under the default matrix, but where a group or host
 * layer raises an `Ask`, the shell refuses the unacknowledged call with the rule named. Sending
 * `true` for a verb nobody was shown a question about would answer that behind the person's back —
 * what is checked here is exactly the acknowledgement travelling with each verb: start, restart,
 * enable and disable go `false`, stop goes `true` but only after the panel's own question.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauri", () => ({
  systemOverview: vi.fn(async () => ({
    services: [{ name: "nginx.service", active: "active", enabled: "enabled" }],
  })),
  systemJournal: vi.fn(),
  systemServiceAction: vi.fn(async () => {}),
}));

import SystemPanel from "@/components/workspace/SystemPanel.vue";
import { i18n } from "@/i18n";
import { systemOverview, systemServiceAction } from "@/lib/backend/tauri";

const overviewMock = vi.mocked(systemOverview);
const actionMock = vi.mocked(systemServiceAction);

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(): Promise<void> {
  app?.unmount();
  host?.remove();

  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(SystemPanel, {
        sessionId: "session-1",
        handle: "w1",
        active: true,
        embedded: true,
      }),
  });
  app.use(i18n);
  app.mount(host);
  await nextTick();
}

beforeEach(() => {
  overviewMock.mockReset();
  overviewMock.mockResolvedValue(fixture("active", "enabled") as unknown as Awaited<ReturnType<typeof systemOverview>>);
  actionMock.mockReset();
  actionMock.mockResolvedValue(undefined);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function body(): HTMLElement {
  const panel = document.querySelector<HTMLElement>("[data-workbench-system]");
  if (!panel) {
    throw new Error("the system panel was not drawn");
  }
  return panel;
}

/** The unit a row draws its buttons from: an inactive unit can start, an active one cannot. */
function fixture(active: string, enabled?: string): unknown {
  return {
    services: [{ name: "nginx.service", active, load: "loaded", sub: "running", enabled, description: "" }],
  };
}

/** The buttons in the unit's row, found by their tooltip ("Start"…"Disable at boot"). */
function rowButton(label: string): HTMLButtonElement {
  const button = [...body().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("title") === label,
  );
  if (!button) {
    throw new Error(`no button titled "${label}"`);
  }
  return button;
}

function dialogButton(label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent?.trim() === label,
  );
  if (!button) {
    throw new Error(`no dialog button "${label}"`);
  }
  return button;
}

describe("the system panel's service verbs", () => {
  it.each([
    ["start", "Start", fixture("failed")],
    ["restart", "Restart", fixture("active", "enabled")],
    ["enable", "Enable at boot", fixture("active", "disabled")],
    ["disable", "Disable at boot", fixture("active", "enabled")],
  ] as const)("sends %s unacknowledged: the panel asks no question of its own", async (verb, label, overview) => {
    overviewMock.mockResolvedValue(overview as unknown as Awaited<ReturnType<typeof systemOverview>>);
    await mount();
    rowButton(label).click();
    await nextTick();

    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(actionMock).toHaveBeenCalledWith("session-1", "w1", "nginx.service", verb, false);
  });

  it("asks about stop in its own words first, then sends the answer along", async () => {
    await mount();
    rowButton("Stop").click();
    await nextTick();

    expect(actionMock, "nothing runs while the question stands").not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("nginx.service");

    dialogButton("Stop service").click();
    await nextTick();
    expect(actionMock).toHaveBeenCalledTimes(1);
    expect(actionMock).toHaveBeenCalledWith("session-1", "w1", "nginx.service", "stop", true);
  });
});
