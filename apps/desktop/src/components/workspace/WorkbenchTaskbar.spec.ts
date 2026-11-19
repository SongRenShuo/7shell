/**
 * The pill along the bottom of the desktop: the way in, the windows that are open, the time and the
 * power control.
 *
 * The bar holds no state, so the tests pin the two things it can get wrong on its own — which cell
 * is drawn as the one in front, and which of the four actions a click announces. The clock text is
 * asserted verbatim: the bar is handed a formatted time and must not reformat it.
 */
import { Folder, Terminal } from "@lucide/vue";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { type App, createApp, defineComponent, h } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import WorkbenchTaskbar from "@/components/workspace/WorkbenchTaskbar.vue";

const ENTRIES = [
  { id: "tab-terminal", label: "web — shell", icon: Terminal, tone: "#1f8a70", active: true },
  { id: "tab-files", label: "web — files", icon: Folder, tone: "#2563eb", active: false },
];

/** A time the bar could not have produced by accident, so "passed through" is a real claim. */
const CLOCK = "09:05";

let launches: string[] = [];
let clocks = 0;
let powers = 0;
let starters = 0;
let app: App | undefined;
let root: HTMLDivElement | undefined;

let desks = 0;

let notices = 0;

function mount(align?: "left" | "center", unreadCount = 0, entries: typeof ENTRIES = ENTRIES): void {
  launches = [];
  clocks = 0;
  powers = 0;
  starters = 0;
  desks = 0;
  notices = 0;
  const Host = defineComponent({
    setup() {
      return () =>
        h(WorkbenchTaskbar, {
          entries,
          clock: CLOCK,
          align,
          power: "Shut down",
          unread: unreadCount,
          labels: {
            starter: "Applications",
            desktop: "Show the desktop",
            desktopEmpty: "Show the desktop (no open windows)",
            clock: "Clock",
            notices: "Notifications",
          },
          onLaunch: (id: string) => {
            launches.push(id);
          },
          onClock: () => {
            clocks += 1;
          },
          onPower: () => {
            powers += 1;
          },
          onStarter: () => {
            starters += 1;
          },
          onDesktop: () => {
            desks += 1;
          },
          onNotices: () => {
            notices += 1;
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
  const element = document.querySelector(`[data-workbench-taskbar-${name}]`);
  if (!(element instanceof HTMLElement)) {
    throw new Error(`the taskbar has no ${name} part`);
  }
  return element;
}

function entries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-workbench-taskbar-entry]")];
}

/** The cell at a stated position, or a failure: the index types cannot promise one is there. */
function entryAt(index: number): HTMLElement {
  const cell = entries()[index];
  if (cell === undefined) {
    throw new Error(`the taskbar has no entry ${index}`);
  }
  return cell;
}

function click(element: Element): void {
  element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
}

describe("the taskbar", () => {
  it("opens the starter from the first cell", () => {
    const cell = part("starter");

    expect(cell.getAttribute("aria-label")).toBe("Applications");
    click(cell);

    expect(starters).toBe(1);
  });

  it("draws one cell for every open window, in the order it was given", () => {
    const cells = entries();

    expect(cells).toHaveLength(ENTRIES.length);
    expect(cells.map((cell) => cell.dataset.entryId)).toEqual(["tab-terminal", "tab-files"]);
  });

  it("marks the window in front and only that one", () => {
    const front = entryAt(0);
    const behind = entryAt(1);

    expect(front.dataset.active).toBe("true");
    expect(behind.dataset.active).toBeUndefined();
    // The front window carries the launch-dock mark: a bar at the cell's left edge, and the wash.
    expect(front.classList.contains("is-active")).toBe(true);
    expect(front.querySelector(".taskbar-mark")).not.toBeNull();
    expect(behind.classList.contains("is-active")).toBe(false);
  });

  it("offers the desktop on its own cell, and says when it was pressed", () => {
    click(part("desktop"));

    expect(desks).toBe(1);
  });

  it("stands the desktop cell down on an empty desk instead of eating a silent press", () => {
    unmountCurrent();
    mount(undefined, 0, []);

    const desktop = part("desktop");
    expect(desktop.hasAttribute("disabled"), "nothing to put away: the cell stands down").toBe(true);
    expect(desktop.className, "the idle look accompanies the state").toContain("is-idle");

    click(desktop);
    expect(desks, "a disabled cell does not answer").toBe(0);
  });

  it("brings forward the window whose cell was clicked", () => {
    click(entryAt(1));

    expect(launches).toEqual(["tab-files"]);
  });

  it("shows the clock exactly as it was handed", () => {
    const clock = part("clock");

    expect(clock.textContent?.trim()).toBe(CLOCK);
    expect(clock.getAttribute("aria-label")).toBe("Clock");
  });

  it("opens the clock when it is clicked", () => {
    click(part("clock"));

    expect(clocks).toBe(1);
  });

  it("announces the power control, label and all", () => {
    const power = part("power");

    expect(power.getAttribute("aria-label")).toBe("Shut down");
    expect(power.textContent?.trim()).toBe("Shut down");
    click(power);

    expect(powers).toBe(1);
  });

  it("dresses its glass, its hover and its running mark from the workbench tokens", () => {
    // The bar is styled in scoped CSS, which no DOM assertion reaches in this environment; the
    // probe is the source itself: the tokens are named and no literal colour is left behind.
    const source = readFileSync(resolve("apps/desktop/src/components/workspace/WorkbenchTaskbar.vue"), "utf8");
    expect(source).toContain("var(--workbench-surface-1)");
    expect(source).toContain("var(--workbench-surface-3)");
    expect(source).toContain("var(--workbench-accent)");
    // The Semi re-skin rounds the pill and its cells at the control radius, not a local number.
    expect(source, "the pill and its cells round at the control step").toContain("var(--wb-radius-control)");
    expect(source).not.toContain("border-radius: 3px");
    expect(source).not.toContain("border-radius: 12px");
    expect(source, "no literal colour is left in the chrome").not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  it("names every button for a reader, and names no two of them the same", () => {
    const buttons = [...document.querySelectorAll<HTMLElement>("[data-workbench-taskbar] button")];
    expect(buttons.length, "the starter, the desktop, every entry, the bell, the clock and the power control").toBe(
      ENTRIES.length + 5,
    );

    const names = buttons.map((button) => button.getAttribute("aria-label"));
    for (const name of names) {
      expect(name, "an unnamed control is a blank spot in a screen reader's walk of the bar").toBeTruthy();
    }
    expect(
      new Set(names).size,
      "two controls answering to one name are indistinguishable before they are clicked",
    ).toBe(names.length);
  });

  it("spans the desk at the reference's insets when no alignment was asked for", () => {
    expect(document.querySelector("[data-workbench-taskbar]")?.classList.contains("is-centered")).toBe(false);
  });

  it("shrinks to its contents and sits in the middle when it is asked to", () => {
    unmountCurrent();
    mount("center");

    const bar = document.querySelector("[data-workbench-taskbar]");
    expect(bar?.classList.contains("is-centered"), "the centred look is the bar's own class").toBe(true);

    click(bar!.querySelector("[data-workbench-taskbar-starter]") as Element);
    expect(starters).toBe(1);
  });

  it("keeps the reference's look when it is told to sit at the insets", () => {
    unmountCurrent();
    mount("left");

    expect(document.querySelector("[data-workbench-taskbar]")?.classList.contains("is-centered")).toBe(false);
  });
});

describe("the notification bell", () => {
  it("sits in the system segment and announces itself when clicked", () => {
    expect(part("notices")).not.toBeNull();

    click(part("notices"));
    expect(notices).toBe(1);
  });

  it("draws no badge when nothing is unread", () => {
    unmountCurrent();
    mount(undefined, 0);

    expect(document.querySelector("[data-workbench-taskbar-notices-badge]")).toBeNull();
  });

  it("wears the unread count the moment there is one", () => {
    unmountCurrent();
    mount(undefined, 3);

    expect(part("notices-badge").textContent?.trim()).toBe("3");
  });

  it("caps the badge at 9+, because a two-digit count is a number nobody reads", () => {
    unmountCurrent();
    mount(undefined, 12);

    expect(part("notices-badge").textContent?.trim()).toBe("9+");
  });
});

/** Takes the current mount down, for the cases that remount with a different alignment. */
function unmountCurrent(): void {
  app?.unmount();
  app = undefined;
  root?.remove();
  root = undefined;
  document.body.innerHTML = "";
}
