/**
 * The notification centre's panel, as its reader meets it: rows grouped by source with a count at
 * each group head, the unread mark that a read row drops, the activation that says both "seen" and
 * "take me there", the clear that is asked about first, and the shared empty drawing when nothing
 * has happened.
 *
 * The rows are handed in already translated — the panel imports no words — so the fixtures speak
 * plain English and the assertions are about the reading, not the translating.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import WorkbenchNotices, { type NoticeRow } from "@/components/workspace/WorkbenchNotices.vue";
import { i18n } from "@/i18n";

let activations: string[] = [];
let clears = 0;
let app: App | undefined;
let host: HTMLDivElement;

const LABELS = {
  title: "Notifications",
  empty: "Nothing has happened.",
  clear: "Clear all",
  clearTitle: "Clear all notifications?",
  clearMessage: "Every notice is removed from the list.",
  clearConfirm: "Clear",
};

const GROUPS = {
  transfer: "Transfers",
  container: "Containers",
  image: "Images",
  tail: "Log tracking",
  power: "System",
  browser: "Browser handover",
};

function row(id: string, source: NoticeRow["source"], extra: Partial<NoticeRow> = {}): NoticeRow {
  return { id, source, title: `${source} ${id}`, atLabel: "09:05", read: false, actionable: false, ...extra };
}

/** The rows the centre draws, in the order the centre's owner would hand them (newest first). */
const ROWS: NoticeRow[] = [
  row("t1", "transfer"),
  row("t2", "transfer", { read: true }),
  row("c1", "container"),
  row("w1", "tail"),
  row("p1", "power", { actionable: false }),
];

function mount(notices: NoticeRow[] = ROWS): void {
  activations = [];
  clears = 0;
  app = createApp({
    render() {
      return h(WorkbenchNotices, {
        notices,
        groupLabels: GROUPS,
        labels: LABELS,
        onActivate: (id: string) => {
          activations.push(id);
        },
        onClear: () => {
          clears += 1;
        },
      });
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  // The panel draws ConfirmDialog, and the dialog reads its own fallback labels from the interface's
  // translations — so the mount carries them, the way every mount over the real app does.
  app.use(i18n);
  app.mount(host);
}

beforeEach(() => {
  mount();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  document.body.innerHTML = "";
});

function rows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("[data-workbench-notices] [data-notice-id]")];
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

/** The one button in the dialog whose text is given, pressed the way a person presses it. */
function dialogButton(label: string): HTMLElement {
  const found = [...document.body.querySelectorAll<HTMLElement>("button")].find(
    (entry) => entry.textContent?.trim() === label,
  );
  if (!found) {
    throw new Error(`no dialog button says ${label}`);
  }
  return found;
}

describe("the grouping", () => {
  it("draws one group per source that has something, with its count at the head", () => {
    const heads = [...host.querySelectorAll<HTMLElement>(".notices-group-head")];
    expect(heads.map((head) => head.textContent?.trim())).toEqual([
      "Transfers2",
      "Containers1",
      "Log tracking1",
      "System1",
    ]);
  });

  it("draws every row under its own group", () => {
    const transfer = rows().filter((entry) => entry.dataset.noticeSource === "transfer");
    expect(transfer).toHaveLength(2);
    expect(transfer[0]?.dataset.noticeId).toBe("t1");
    expect(transfer[1]?.dataset.noticeId).toBe("t2");
  });
});

describe("the rows", () => {
  it("marks the rows a session has not read, and drops the mark on a read one", () => {
    const unread = rows().find((entry) => entry.dataset.noticeId === "t1");
    const read = rows().find((entry) => entry.dataset.noticeId === "t2");

    expect(unread?.dataset.read).toBeUndefined();
    expect(read?.dataset.read).toBe("true");
  });

  it("says when each row happened, exactly as it was handed over", () => {
    expect(rows()[0]?.textContent).toContain("09:05");
  });

  it("announces a click on a row with the row's id", () => {
    click(rows()[0]!);

    expect(activations).toEqual(["t1"]);
  });
});

describe("clearing", () => {
  it("is out of reach while the list is empty", () => {
    app?.unmount();
    mount([]);

    expect(
      (host.querySelector("[data-workbench-notices-clear]") as HTMLButtonElement).disabled,
      "nothing to clear is not a button",
    ).toBe(true);
  });

  it("asks first, and clears only when the answer is yes", async () => {
    click(host.querySelector("[data-workbench-notices-clear]") as Element);
    await nextTick();

    expect(clears).toBe(0);

    click(dialogButton("Clear"));
    expect(clears).toBe(1);
  });

  it("leaves the rows alone when the confirmation is dismissed", async () => {
    click(host.querySelector("[data-workbench-notices-clear]") as Element);
    await nextTick();
    // The dialog's own close: a click outside is its "no".
    click(dialogButton("Cancel"));

    expect(clears).toBe(0);
  });
});

describe("the empty state", () => {
  it("is the desktop's shared empty drawing, saying what the owner handed over", () => {
    app?.unmount();
    mount([]);

    const empty = host.querySelector<HTMLElement>("[data-wb-empty]");
    expect(empty, "the shared drawing, not a bare sentence").not.toBeNull();
    expect(empty?.dataset.scenario).toBe("noData");
    expect(host.querySelector("[data-workbench-notices]")?.textContent).toContain("Nothing has happened.");
  });
});

describe("the panel's skin", () => {
  it("draws from the workbench tokens, with no literal colour left in the sheet", () => {
    // The panel's glass is scoped CSS, invisible to DOM assertions here; the probe is the source:
    // the Semi-era sheet tokens are named and no literal colour is left behind.
    const source = readFileSync(resolve("apps/desktop/src/components/workspace/WorkbenchNotices.vue"), "utf8");
    expect(source, "the sheet is the raised surface").toContain("var(--workbench-surface-2)");
    expect(source, "the modal tier lifts it").toContain("var(--wb-shadow-elevated)");
    expect(source, "the unread mark is the brand").toContain("var(--workbench-accent)");
    expect(source, "no literal colour is left in the chrome").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
