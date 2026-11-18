/**
 * The pill along the bottom of the desktop: the way in, the windows that are open, the time and the
 * power control.
 *
 * The bar holds no state, so the tests pin the two things it can get wrong on its own — which cell
 * is drawn as the one in front, and which of the four actions a click announces. The clock text is
 * asserted verbatim: the bar is handed a formatted time and must not reformat it.
 */
import { Folder, Terminal } from "@lucide/vue";
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

function mount(): void {
  launches = [];
  clocks = 0;
  powers = 0;
  starters = 0;
  const Host = defineComponent({
    setup() {
      return () =>
        h(WorkbenchTaskbar, {
          entries: ENTRIES,
          clock: CLOCK,
          power: "Shut down",
          labels: { starter: "Applications", clock: "Clock" },
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
    expect(front.querySelector(".taskbar-dot")?.classList.contains("is-active")).toBe(true);
    expect(behind.querySelector(".taskbar-dot")?.classList.contains("is-active")).toBe(false);
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
});
