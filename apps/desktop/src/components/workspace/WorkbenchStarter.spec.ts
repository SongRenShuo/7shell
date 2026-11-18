/**
 * The starter sheet, as a person uses it: every application on one page, one click to launch, and
 * more than one way to put the sheet away.
 *
 * The component holds nothing of its own, so what is worth pinning is the wiring: one tile per app,
 * the click saying *which* app rather than just that something was clicked, the backdrop and Escape
 * both closing, and the closed sheet keeping its tiles out of reach — a hidden-but-focusable tile is
 * the classic "the sheet is closed and the keyboard is still inside it" bug.
 */
import { Folder, Terminal } from "@lucide/vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import WorkbenchStarter from "@/components/workspace/WorkbenchStarter.vue";

const APPS = [
  { id: "terminal", label: "Terminal", icon: Terminal, tone: "#1f8a70" },
  { id: "files", label: "Files", icon: Folder, tone: "#2563eb" },
];

let launches: string[] = [];
let closes = 0;
let app: App | undefined;
let root: HTMLDivElement | undefined;
let open = ref(false);

/** Mounts the sheet already open or already closed, and records what it says. */
function mount(shown: boolean): void {
  launches = [];
  closes = 0;
  open = ref(shown);
  const Host = defineComponent({
    setup() {
      return () =>
        h(WorkbenchStarter, {
          open: open.value,
          apps: APPS,
          labels: {
            title: "Applications",
            close: "Close",
            search: "Search applications",
            noResults: "Nothing matches",
          },
          onClose: () => {
            closes += 1;
          },
          onLaunch: (id: string) => {
            launches.push(id);
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
  mount(true);
});

afterEach(() => {
  vi.useRealTimers();
  app?.unmount();
  app = undefined;
  root?.remove();
  root = undefined;
  document.body.innerHTML = "";
});

function sheet(): HTMLElement {
  const element = document.querySelector("[data-workbench-starter]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("the starter is not on the page");
  }
  return element;
}

function tiles(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-workbench-starter-app]")];
}

/** The tile at a stated position, or a failure: the index types cannot promise one is there. */
function tileAt(index: number): HTMLElement {
  const tile = tiles()[index];
  if (tile === undefined) {
    throw new Error(`the sheet has no tile ${index}`);
  }
  return tile;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("the starter sheet", () => {
  it("draws one tile for every application, in the order it was given", () => {
    const drawn = tiles();

    expect(drawn).toHaveLength(APPS.length);
    expect(drawn.map((tile) => tile.dataset.appId)).toEqual(["terminal", "files"]);
    expect(drawn.map((tile) => tile.textContent?.trim())).toEqual(["Terminal", "Files"]);
  });

  it("launches the application the clicked tile names, and leaves the sheet open", () => {
    click(tileAt(0));

    expect(launches).toEqual(["terminal"]);
    expect(closes).toBe(0);
  });

  it("closes when the sheet itself is clicked between the tiles", () => {
    click(sheet());

    expect(closes).toBe(1);
    expect(launches).toEqual([]);
  });

  it("closes on Escape", () => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(closes).toBe(1);
  });

  it("ignores Escape while it is closed", () => {
    app?.unmount();
    document.body.innerHTML = "";
    mount(false);

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(closes).toBe(0);
  });

  it("keeps a closed sheet's tiles out of reach", () => {
    app?.unmount();
    document.body.innerHTML = "";
    mount(false);

    expect(sheet().style.display).toBe("none");
    expect(sheet().hasAttribute("inert")).toBe(true);
  });

  it("lets the tiles be reached again once it is open", () => {
    expect(sheet().hasAttribute("inert")).toBe(false);
    expect(sheet().style.display).toBe("");
  });

  it("can be put away with the button in the corner", () => {
    const close = document.querySelector("[data-workbench-starter-close]");
    if (close === null) {
      throw new Error("the sheet has no close button");
    }
    click(close);

    expect(closes).toBe(1);
  });

  it("draws its sheet from the workbench surface token, with no literal colour left", () => {
    // The sheet's glass is scoped CSS, invisible to DOM assertions here; the probe is the source.
    const source = readFileSync(resolve("apps/desktop/src/components/workspace/WorkbenchStarter.vue"), "utf8");
    expect(source).toContain("var(--workbench-surface-2)");
    expect(source).toContain("var(--workbench-on-picture-muted)");
    expect(source, "no literal colour is left in the chrome").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("filters the grid after the query settles, and keeps every tile before it does", async () => {
    vi.useFakeTimers();
    const field = document.querySelector<HTMLInputElement>("[data-workbench-starter-search]");
    expect(field, "an open sheet carries its search field").not.toBeNull();

    field!.value = "term";
    field!.dispatchEvent(new Event("input", { bubbles: true }));

    // Before the debounce settles, the whole grid is still there: a filter that moved on every
    // keystroke would thrash the grid while a word is being typed.
    expect(tiles(), "the filter waits for the query to settle").toHaveLength(2);

    vi.advanceTimersByTime(300);
    await nextTick();
    expect(tiles(), "only the application the query names").toHaveLength(1);
    expect(tiles()[0]?.dataset.appId).toBe("terminal");
  });

  it("says when nothing matches, instead of drawing an empty grid", async () => {
    vi.useFakeTimers();
    const field = document.querySelector<HTMLInputElement>("[data-workbench-starter-search]");
    field!.value = "printer";
    field!.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(300);
    await nextTick();

    expect(document.querySelector("[data-workbench-starter-empty]"), "the nothing-matches line").not.toBeNull();
    expect(tiles()).toHaveLength(0);
  });

  it("forgets the query when the sheet closes, so reopening shows every application", async () => {
    vi.useFakeTimers();
    const field = document.querySelector<HTMLInputElement>("[data-workbench-starter-search]");
    field!.value = "term";
    field!.dispatchEvent(new Event("input", { bubbles: true }));
    vi.advanceTimersByTime(300);
    await nextTick();
    expect(tiles()).toHaveLength(1);

    open.value = false;
    await nextTick();
    open.value = true;
    await nextTick();

    expect(tiles(), "a reopened sheet filters nothing").toHaveLength(2);
    // The field was rebuilt with the sheet (it exists only while the sheet is open), so the fresh
    // element is what carries the emptied query.
    const reopened = document.querySelector<HTMLInputElement>("[data-workbench-starter-search]");
    expect(reopened?.value, "and the field itself is empty again").toBe("");
  });
});
