/**
 * The trash panel's destructive edge, as it is met: neither of the two verbs that delete for good
 * runs without a question naming what is about to be lost.
 *
 * `Core::trash_remove` is `Destructive` — the same level as emptying — and the matrix's `Ask`
 * reaches the person only if the panel does not answer it on their behalf. What is checked here is
 * exactly that: the delete-for-good button opens the confirmation, nothing is sent before the
 * answer, the confirmation carries the acknowledgement, and walking away sends nothing.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/backend/tauri", () => ({
  trashList: vi.fn(async () => []),
  trashRestore: vi.fn(),
  trashRemove: vi.fn(),
  trashEmpty: vi.fn(),
}));

import TrashWindow from "@/components/workspace/TrashWindow.vue";
import { i18n } from "@/i18n";
import { trashList, trashRemove } from "@/lib/backend/tauri";

const trashListMock = vi.mocked(trashList);
const trashRemoveMock = vi.mocked(trashRemove);

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(): Promise<void> {
  app?.unmount();
  host?.remove();

  host = document.createElement("div");
  document.body.append(host);
  app = createApp({
    render: () =>
      h(TrashWindow, {
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

/** One entry, paired with its sidecar, the shape the list draws rows from. */
const ENTRY = {
  id: "cf8b1f60-old.log",
  name: "old.log",
  isDir: false,
  originalPath: "/var/log/old.log",
};

beforeEach(() => {
  trashListMock.mockReset();
  trashRemoveMock.mockReset();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  host = undefined;
});

function body(): HTMLElement {
  const panel = document.querySelector<HTMLElement>("[data-workbench-trash]");
  if (!panel) {
    throw new Error("the trash panel was not drawn");
  }
  return panel;
}

function buttonByTitle(title: string): HTMLButtonElement {
  const button = [...body().querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.getAttribute("title") === title,
  );
  if (!button) {
    throw new Error(`no button titled "${title}"`);
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

describe("the trash panel's delete-for-good", () => {
  it("asks before it deletes: the button opens a question naming the entry, nothing is sent first", async () => {
    trashListMock.mockResolvedValue([ENTRY]);
    await mount();

    buttonByTitle("Delete for good").click();
    await nextTick();

    const question = document.querySelector('[role="dialog"]');
    expect(question, "the question is on screen, not in the click").not.toBeNull();
    expect(document.body.textContent).toContain("old.log");
    expect(trashRemoveMock, "nothing runs while the question stands").not.toHaveBeenCalled();
  });

  it("sends the removal with the acknowledgement only after the answer", async () => {
    trashListMock.mockResolvedValue([ENTRY]);
    await mount();

    buttonByTitle("Delete for good").click();
    await nextTick();
    dialogButton("Delete for good").click();
    await nextTick();

    expect(trashRemoveMock).toHaveBeenCalledTimes(1);
    expect(trashRemoveMock).toHaveBeenCalledWith("w1", "session-1", ENTRY.id, true);
  });

  it("sends nothing when the question is walked away from", async () => {
    trashListMock.mockResolvedValue([ENTRY]);
    await mount();

    buttonByTitle("Delete for good").click();
    await nextTick();
    dialogButton("Cancel").click();
    await nextTick();

    expect(trashRemoveMock).not.toHaveBeenCalled();
    // And the panel still lists what it listed — nothing was lost to the walk-away.
    expect(trashListMock).toHaveBeenCalledTimes(1);
  });
});

describe("the trash panel's failed read", () => {
  it("the failure banner carries the retry, and the retry is the same read again", async () => {
    trashListMock.mockRejectedValue({
      version: 1,
      code: "SESSION-CLOSED",
      messageKey: "errors.session.closed",
      messageParams: {},
      origin: { subsystem: "session" },
      outcome: "failed",
    });
    await mount();
    await vi.waitFor(() => {
      // The banner says what happened in words; the trash banner carries no code line.
      expect(body().textContent).toContain("no longer connected");
    });

    // The read failed; the empty state stays out of the way (a failed read is not an empty trash).
    expect(body().querySelector("[data-wb-empty]")).toBeNull();

    // The retry asks the same question again, and this time it is answered.
    trashListMock.mockReturnValue(Promise.resolve([ENTRY]));
    const retry = [...body().querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Retry",
    );
    if (!retry) {
      throw new Error("the failure banner carries no retry");
    }
    retry.click();
    await vi.waitFor(() => {
      expect(body().textContent).toContain("old.log");
    });
    expect(body().textContent).not.toContain("no longer connected");
  });

  it("the size column wears the numbers track", async () => {
    trashListMock.mockResolvedValue([{ ...ENTRY, size: 2048 }]);
    await mount();
    await vi.waitFor(() => {
      expect(body().textContent).toContain("old.log");
    });

    const sizeCell = [...body().querySelectorAll("td")].find((cell) => cell.textContent?.trim() === "2.0 KB");
    expect(sizeCell, "the size is drawn").not.toBeUndefined();
    expect(sizeCell?.className).toContain("nums");
    expect(sizeCell?.className).not.toContain("font-mono");
  });
});
