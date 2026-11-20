/**
 * The update's gate, walked question by question: the five steps in their order, the way out on
 * every one of them, and a confirm that is only a flag — the pull belongs to the page.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  dockerInfo: vi.fn(async () => ({})),
}));

import ImageUpdateDialog from "@/components/container/ImageUpdateDialog.vue";
import { i18n } from "@/i18n";
import { dockerInfo } from "@/lib/backend/tauri";
import type { ContainerSummary } from "@/types/container";

const infoMock = vi.mocked(dockerInfo);

let app: App | undefined;
let host: HTMLDivElement | undefined;

const affected: ContainerSummary[] = [
  { id: "c1", name: "web", image: "app:1", state: "running", status: "Up", ports: "", createdAt: "now" },
  { id: "c2", name: "api", image: "app:1", state: "exited", status: "Exited", ports: "", createdAt: "now" },
];

interface Events {
  confirm: number;
  closed: number;
}

async function mount(events: Events): Promise<void> {
  app = createApp({
    render: () =>
      h(ImageUpdateDialog, {
        open: true,
        reference: "app:1",
        affected,
        connectionId: "conn-1",
        busy: false,
        onConfirm: () => {
          events.confirm += 1;
        },
        "onUpdate:open": (value: boolean) => {
          if (!value) {
            events.closed += 1;
          }
        },
      }),
  });
  app.use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

function stepLabel(): string {
  return document.querySelector("[data-update-step-label]")?.textContent?.trim() ?? "";
}

function footerButton(label: string): HTMLElement | null {
  return [...document.querySelectorAll("footer button")].find((entry) => entry.textContent?.includes(label)) ?? null;
}

/**
 * Walks the dialog to the step named, one Continue at a time.
 *
 * The wait after each press has to fail while the DOM still shows the step the press left — a
 * first check that runs before Vue's flush would pass on the stale label and the walk would take
 * two steps for one press. So the wait is "no longer the step it was, and now the one asked for".
 */
async function toStep(step: number): Promise<void> {
  for (let seen = stepLabel(); !seen.includes(`Step ${step} of 5`); seen = stepLabel()) {
    await vi.waitFor(() => expect(footerButton("Continue")).not.toBeNull());
    footerButton("Continue")?.click();
    const previous = seen;
    const next = Number(/Step (\d+) of/.exec(previous)?.[1] ?? "0") + 1;
    await vi.waitFor(() => {
      const now = stepLabel();
      expect(now, "the press moved the dialog off the step it was on").not.toContain(previous);
      expect(now).toContain(`Step ${next} of 5`);
    });
  }
}

beforeEach(() => {
  infoMock.mockClear();
  infoMock.mockResolvedValue({});
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the update dialog", () => {
  it("names the containers the image runs, and lets step one be declined", async () => {
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    expect(stepLabel()).toContain("Step 1 of 5");
    const body = document.querySelector("[data-update-step-affected]")?.textContent ?? "";
    expect(body).toContain("web — running");
    expect(body).toContain("api — exited");

    footerButton("Cancel")?.click();
    await nextTick();
    expect(events.closed).toBe(1);
    expect(events.confirm).toBe(0);
  });

  it("says the data sentence before it says where the pull would go", async () => {
    infoMock.mockResolvedValue({ mirrors: ["https://docker.gmssh.com/"] });
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    await toStep(2);
    expect(document.querySelector("[data-update-step-data]")).not.toBeNull();
    await toStep(3);
    await vi.waitFor(() => expect(infoMock).toHaveBeenCalledWith("conn-1"));
    expect(document.querySelector("[data-update-step-mirrors]")?.textContent).toContain("https://docker.gmssh.com/");
  });

  it("says when the daemon has no mirrors", async () => {
    infoMock.mockResolvedValue({});
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    await toStep(3);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-update-step-mirrors]")?.textContent).toContain("No mirror is configured"),
    );
  });

  it("says when the daemon does not answer the mirrors question", async () => {
    infoMock.mockRejectedValue({ code: "CONTAINER-UNAVAILABLE" });
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    await toStep(3);
    await vi.waitFor(() =>
      expect(document.querySelector("[data-update-step-mirrors]")?.textContent).toContain("did not answer"),
    );
  });

  it("carries the non-cancellable sentence, then the remedy, then only a flag", async () => {
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    await toStep(4);
    expect(document.querySelector("[data-update-step-committing]")).not.toBeNull();
    // Step four still leaves; nothing has been sent anywhere.
    footerButton("Cancel")?.click();
    await nextTick();
    expect(events.confirm).toBe(0);
  });

  it("hands the confirm over as a flag and nothing more", async () => {
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    await toStep(5);
    expect(document.querySelector("[data-update-step-failure]")).not.toBeNull();
    footerButton("Update")?.click();
    await nextTick();
    expect(events.confirm).toBe(1);
    expect(events.closed, "the confirm is not a close: the page owns the dialog").toBe(0);
  });

  it("can be walked back without losing the place", async () => {
    const events: Events = { confirm: 0, closed: 0 };
    await mount(events);
    await toStep(3);
    footerButton("Back")?.click();
    await nextTick();
    expect(stepLabel()).toContain("Step 2 of 5");
    footerButton("Continue")?.click();
    await nextTick();
    expect(stepLabel()).toContain("Step 3 of 5");
  });
});
