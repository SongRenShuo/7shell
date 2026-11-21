/**
 * The system panel's service verbs, as they reach the shell: what the panel asks about it answers
 * for, and what it does not ask about it sends unacknowledged.
 *
 * The verbs are `Caution` and simply run under the default matrix, but where a group or host
 * layer raises an `Ask`, the shell refuses the unacknowledged call with the rule named. Sending
 * `true` for a verb nobody was shown a question about would answer that behind the person's back —
 * what is checked here is exactly the acknowledgement travelling with each verb: start, restart,
 * enable and disable go `false`, stop goes `true` but only after the panel's own question.
 *
 * A second describe covers the first screen: the machine's facts draw on their own line and wrap
 * rather than truncate (a timezone cut at the margin is a fact hidden while shown), the services
 * summary opens the section with the failed count as its filter, the rows wear the desktop's
 * status lights, and the first read is a skeleton that steps aside whole when the overview lands.
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

describe("the disk rings", () => {
  /** A mount filled to the percent named — the sizes are only the ratio a ring reads. */
  function mountsAt(percent: number): unknown {
    return {
      services: [],
      mounts: [{ filesystem: "/dev/sda1", mountPoint: "/", sizeBytes: 100, availableBytes: 100 - percent }],
    };
  }

  function disksTab(): HTMLButtonElement {
    const found = [...document.querySelectorAll<HTMLButtonElement>("[data-workbench-system-tabs] button")].find(
      (button) => button.textContent?.trim() === "Disks",
    );
    if (!found) {
      throw new Error("no disks tab is drawn");
    }
    return found;
  }

  function ring(): SVGSVGElement {
    const found = document.querySelector<SVGSVGElement>("[data-workbench-system-mounts] svg");
    if (!found) {
      throw new Error("no disk ring is drawn");
    }
    return found;
  }

  // The rings used to go straight to red at ninety, so ninety-four and ninety-nine wore the same
  // colour. The gauge draws the arc in the tier `usageTone` names — the amber step between ninety
  // and ninety-five is the tier the desktops share, not this panel's own.
  it.each([
    [89, "var(--success)"],
    [92, "var(--warning)"],
    [96, "var(--destructive)"],
  ] as const)("wears the tier the desktops share at %i%%: %s", async (percent, token) => {
    overviewMock.mockResolvedValue(mountsAt(percent) as unknown as Awaited<ReturnType<typeof systemOverview>>);
    await mount();
    await nextTick();

    disksTab().click();
    await nextTick();
    await nextTick();

    expect(ring().querySelectorAll("circle")[1]?.getAttribute("stroke")).toBe(token);
  });
});

describe("the system panel's first screen", () => {
  /** An overview naming a few units, with the machine's own facts — a long timezone among them. */
  function servicesFixture(entries: readonly { name: string; active: string }[]): unknown {
    return {
      services: entries.map((entry) => ({
        name: entry.name,
        load: "loaded",
        active: entry.active,
        sub: "running",
        description: "",
      })),
      distribution: "Debian GNU/Linux 12",
      kernel: "6.1.0-18-amd64",
      uptimeSeconds: 982392,
      timezone: "Asia/Shanghai",
    };
  }

  function summary(): HTMLElement {
    const found = document.querySelector<HTMLElement>("[data-workbench-system-summary]");
    if (!found) {
      throw new Error("the services summary was not drawn");
    }
    return found;
  }

  function failedFilter(): HTMLButtonElement {
    const found = document.querySelector<HTMLButtonElement>("[data-workbench-system-failed-filter]");
    if (!found) {
      throw new Error("the failed filter was not drawn");
    }
    return found;
  }

  function lights(): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>("[data-workbench-system-service-light]")];
  }

  // The facts used to share the tab row's tail and truncate there, so a timezone arrived as
  // "Asia/Sha…" — the panel showing and hiding the same fact at once. They now have a line of
  // their own, which wraps.
  it("the machine's facts draw on their own line, and wrap instead of truncating", async () => {
    overviewMock.mockResolvedValue(
      servicesFixture([{ name: "nginx.service", active: "active" }]) as unknown as Awaited<
        ReturnType<typeof systemOverview>
      >,
    );
    await mount();
    await nextTick();

    const facts = document.querySelector<HTMLElement>("[data-workbench-system-facts]");
    expect(facts, "the facts line is drawn").not.toBeNull();
    expect(facts?.textContent).toContain("Asia/Shanghai");
    expect(facts?.className, "the line wraps rather than cutting").toContain("flex-wrap");
    for (const fact of facts?.querySelectorAll("span") ?? []) {
      expect(fact.className, "a fact is never cut at the margin").not.toContain("truncate");
    }
    // And the tab row carries none of it — the line is the facts' own.
    expect(document.querySelector("[data-workbench-system-tabs]")?.textContent).not.toContain("Asia/Shanghai");
  });

  it("opens onto the summary — how many run, how many failed, how many neither", async () => {
    overviewMock.mockResolvedValue(
      servicesFixture([
        { name: "a.service", active: "active" },
        { name: "b.service", active: "active" },
        { name: "c.service", active: "failed" },
        { name: "d.service", active: "inactive" },
      ]) as unknown as Awaited<ReturnType<typeof systemOverview>>,
    );
    await mount();
    await nextTick();

    expect(summary().textContent).toContain("2 running");
    expect(summary().textContent).toContain("1 failed");
    expect(summary().textContent).toContain("1 inactive");
    // The failed count wears the destructive tone while there is a failure to read about.
    expect(failedFilter().className).toContain("text-destructive");
  });

  it("the failed count is the filter: pressed, the table narrows to the failures", async () => {
    overviewMock.mockResolvedValue(
      servicesFixture([
        { name: "a.service", active: "active" },
        { name: "c.service", active: "failed" },
        { name: "d.service", active: "inactive" },
      ]) as unknown as Awaited<ReturnType<typeof systemOverview>>,
    );
    await mount();
    await nextTick();
    expect(lights().length).toBe(3);

    failedFilter().click();
    await nextTick();
    await nextTick();

    expect(failedFilter().getAttribute("aria-pressed")).toBe("true");
    expect(lights().length).toBe(1);
    expect(lights()[0]?.dataset.serviceState).toBe("failed");
    expect(lights()[0]?.className).toContain("bg-destructive");
  });

  it("a refresh that clears every failure widens the table back — no empty room behind a pressed button", async () => {
    overviewMock.mockResolvedValue(
      servicesFixture([
        { name: "a.service", active: "active" },
        { name: "c.service", active: "failed" },
      ]) as unknown as Awaited<ReturnType<typeof systemOverview>>,
    );
    await mount();
    await nextTick();
    failedFilter().click();
    await nextTick();
    expect(lights().length).toBe(1);

    // The next read answers that nothing failed any more: the filter has nothing to narrow to.
    overviewMock.mockResolvedValue(
      servicesFixture([{ name: "a.service", active: "active" }]) as unknown as Awaited<
        ReturnType<typeof systemOverview>
      >,
    );
    // The refresh button is found by its tooltip, like every button in this suite.
    const refresh = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.getAttribute("title") === "Read the machine again",
    );
    if (!refresh) {
      throw new Error("the refresh button was not drawn");
    }
    refresh.click();
    await vi.waitFor(() => {
      expect(lights().length).toBe(1);
      expect(lights()[0]?.dataset.serviceState).toBe("active");
    });
    expect(failedFilter().disabled, "nothing to narrow to").toBe(true);
    expect(failedFilter().getAttribute("aria-pressed")).toBe("false");
  });

  it("the first read is the skeleton, and it steps aside whole when the overview lands", async () => {
    let arrive!: (overview: Awaited<ReturnType<typeof systemOverview>>) => void;
    overviewMock.mockReturnValue(
      new Promise<Awaited<ReturnType<typeof systemOverview>>>((resolve) => {
        arrive = resolve;
      }),
    );
    await mount();
    await nextTick();
    expect(document.querySelector("[data-workbench-system-skeleton]")).not.toBeNull();
    expect(document.querySelector("[data-workbench-system-summary]")).toBeNull();

    // The answer arrives: the skeleton goes, the summary is there, in the same render.
    arrive(servicesFixture([{ name: "a.service", active: "active" }]) as Awaited<ReturnType<typeof systemOverview>>);
    await vi.waitFor(() => {
      expect(document.querySelector("[data-workbench-system-summary]")).not.toBeNull();
    });
    expect(document.querySelector("[data-workbench-system-skeleton]")).toBeNull();
    expect(lights().length).toBe(1);
  });
});
