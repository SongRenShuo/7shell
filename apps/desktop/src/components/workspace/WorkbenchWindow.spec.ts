/**
 * The chrome's own behaviour, from the pointer's side: what a press raises, what a drag sends, and
 * what the three buttons mean.
 *
 * The window list's suite states the arithmetic; this one states the contract between a gesture and
 * the numbers it hands over. The events are dispatched on the real DOM rather than through a test
 * helper's wrappers, because the thing being checked is that a pointerdown on a button is not a
 * drag and that a pointer that crosses the top line maximises once — both are facts about event
 * targets and phases, which a synthetic shortcut would hide.
 */
import { type App, createApp, defineComponent, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import WorkbenchWindow from "@/components/workspace/WorkbenchWindow.vue";
import { MIN_HEIGHT, MIN_WIDTH } from "@/lib/workbench/windows";

type Mode = "normal" | "min" | "max";

/** The state the host hands the window; changed between renders the way the real caller would. */
const mode = ref<Mode>("normal");
const focused = ref(true);
const left = ref(100);
const top = ref(100);
const width = ref(666);
const height = ref(422);
const closing = ref(false);

const calls = { focus: 0, close: 0, minimize: 0, maximize: 0, restore: 0 };
const moves: { left: number; top: number }[] = [];
const resizes: { width: number; height: number }[] = [];

const StubIcon = defineComponent({ render: () => h("span", { "data-stub-icon": "" }) });

const Host = defineComponent({
  setup() {
    return () =>
      h(
        WorkbenchWindow,
        {
          id: "w1",
          title: "Terminal",
          icon: StubIcon,
          state: mode.value,
          focused: focused.value,
          left: left.value,
          top: top.value,
          width: width.value,
          height: height.value,
          closing: closing.value,
          labels: { minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
          onFocus: () => {
            calls.focus += 1;
          },
          onClose: () => {
            calls.close += 1;
          },
          onMinimize: () => {
            calls.minimize += 1;
          },
          onMaximize: () => {
            calls.maximize += 1;
          },
          onRestore: () => {
            calls.restore += 1;
          },
          onMove: (payload: { left: number; top: number }) => moves.push(payload),
          onResize: (payload: { width: number; height: number }) => resizes.push(payload),
        },
        { default: () => h("p", { "data-content": "" }, "the content") },
      );
  },
});

let app: App | undefined;
let host: HTMLDivElement;

beforeEach(() => {
  mode.value = "normal";
  focused.value = true;
  left.value = 100;
  top.value = 100;
  width.value = 666;
  height.value = 422;
  closing.value = false;
  calls.focus = 0;
  calls.close = 0;
  calls.minimize = 0;
  calls.maximize = 0;
  calls.restore = 0;
  moves.length = 0;
  resizes.length = 0;

  host = document.createElement("div");
  document.body.append(host);
  app = createApp(Host);
  app.mount(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
  document.body.innerHTML = "";
});

function root(): HTMLElement {
  const element = document.querySelector("[data-workbench-window]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("the window is not on the page");
  }
  return element;
}

function titleBar(): HTMLElement {
  const element = document.querySelector("[data-workbench-window-title]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("the window has no title bar");
  }
  return element;
}

function grip(): HTMLElement {
  const element = document.querySelector("[data-workbench-window-grip]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("the window has no resize grip");
  }
  return element;
}

/** A pointer event the way the browser delivers one. */
function pointer(type: string, clientX: number, clientY: number): PointerEvent {
  return new PointerEvent(type, { clientX, clientY, button: 0, pointerId: 1, bubbles: true, cancelable: true });
}

/** A whole press: down on the title bar at the given point. */
function pressTitle(clientX = 200, clientY = 100): void {
  titleBar().dispatchEvent(pointer("pointerdown", clientX, clientY));
}

describe("the chrome", () => {
  it("draws the title, the icon and the slotted content", () => {
    expect(titleBar().textContent).toContain("Terminal");
    expect(document.querySelector("[data-stub-icon]")).not.toBeNull();
    expect(document.querySelector("[data-content]")?.textContent).toBe("the content");
  });

  it("labels the three buttons from the props, for both the pointer and a screen reader", () => {
    const buttons = {
      minimize: document.querySelector("[data-workbench-window-min]"),
      maximize: document.querySelector("[data-workbench-window-max]"),
      close: document.querySelector("[data-workbench-window-close]"),
    };

    for (const [key, button] of Object.entries(buttons)) {
      expect(button).not.toBeNull();
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      expect(button?.getAttribute("aria-label")).toBe(label);
      expect(button?.getAttribute("title")).toBe(label);
    }
  });

  it("says which window it draws, and in which mode", async () => {
    expect(root().getAttribute("data-window-id")).toBe("w1");
    expect(root().getAttribute("data-window-state")).toBe("normal");

    mode.value = "min";
    await nextTick();

    expect(root().getAttribute("data-window-state")).toBe("min");
  });

  it("wears the focus ring only while it is the focused window", async () => {
    expect(root().className).toContain("ring-primary/70");

    focused.value = false;
    await nextTick();

    expect(root().className).not.toContain("ring-primary/70");
  });
});

describe("the three buttons", () => {
  it("emit minimize, maximize and close", () => {
    (document.querySelector("[data-workbench-window-min]") as HTMLElement).click();
    (document.querySelector("[data-workbench-window-max]") as HTMLElement).click();
    (document.querySelector("[data-workbench-window-close]") as HTMLElement).click();

    expect(calls.minimize).toBe(1);
    expect(calls.maximize).toBe(1);
    expect(calls.close).toBe(1);
    expect(calls.restore).toBe(0);
  });

  it("offer restore instead of maximize while the window is maximised", async () => {
    mode.value = "max";
    await nextTick();

    const button = document.querySelector("[data-workbench-window-max]");
    expect(button?.getAttribute("title")).toBe("Restore");

    (button as HTMLElement).click();
    expect(calls.restore).toBe(1);
    expect(calls.maximize).toBe(0);
  });

  it("do not start a title-bar drag", () => {
    (document.querySelector("[data-workbench-window-close]") as HTMLElement).dispatchEvent(
      pointer("pointerdown", 200, 100),
    );
    titleBar().dispatchEvent(pointer("pointermove", 230, 140));

    expect(moves).toEqual([]);
  });
});

describe("dragging the title bar", () => {
  it("asks for the geometry the pointer travelled to, and raises the window first", () => {
    pressTitle(200, 100);
    titleBar().dispatchEvent(pointer("pointermove", 230, 140));

    expect(calls.focus).toBe(1);
    expect(moves).toEqual([{ left: 130, top: 140 }]);
  });

  it("measures every move from where the drag began, not from the previous emission", () => {
    pressTitle(200, 100);
    titleBar().dispatchEvent(pointer("pointermove", 210, 110));
    titleBar().dispatchEvent(pointer("pointermove", 250, 160));

    expect(moves).toEqual([
      { left: 110, top: 110 },
      { left: 150, top: 160 },
    ]);
  });

  it("stops sending moves once the pointer is released", () => {
    pressTitle(200, 100);
    titleBar().dispatchEvent(pointer("pointerup", 200, 100));
    titleBar().dispatchEvent(pointer("pointermove", 300, 300));

    expect(moves).toEqual([]);
  });

  it("maximises once when the pointer crosses the top line, and ends the drag", () => {
    pressTitle(200, 100);
    titleBar().dispatchEvent(pointer("pointermove", 210, 10));

    expect(calls.maximize).toBe(1);
    expect(moves).toEqual([]);

    titleBar().dispatchEvent(pointer("pointermove", 220, 5));
    titleBar().dispatchEvent(pointer("pointermove", 300, 200));

    expect(calls.maximize).toBe(1);
    expect(moves).toEqual([]);
  });

  it("does not drag a window that is not in its normal mode", async () => {
    mode.value = "max";
    await nextTick();

    pressTitle();
    titleBar().dispatchEvent(pointer("pointermove", 250, 150));

    expect(moves).toEqual([]);
  });

  it("still raises the window when the press lands in the body", () => {
    (document.querySelector("[data-content]") as HTMLElement).dispatchEvent(pointer("pointerdown", 300, 300));

    expect(calls.focus).toBe(1);
  });
});

describe("resizing from the grip", () => {
  it("asks for the size the pointer travelled to, without starting a move", () => {
    grip().dispatchEvent(pointer("pointerdown", 300, 300));
    grip().dispatchEvent(pointer("pointermove", 350, 340));

    expect(resizes).toEqual([{ width: 716, height: 462 }]);
    expect(moves).toEqual([]);
  });

  it("never asks for less than the minimum", () => {
    grip().dispatchEvent(pointer("pointerdown", 300, 300));
    grip().dispatchEvent(pointer("pointermove", -1000, -1000));

    expect(resizes).toEqual([{ width: MIN_WIDTH, height: MIN_HEIGHT }]);
  });

  it("is not drawn while the window is maximised", async () => {
    mode.value = "max";
    await nextTick();

    expect(document.querySelector("[data-workbench-window-grip]")).toBeNull();
  });
});

describe("the modes", () => {
  it("collapses a minimised window without unmounting its content", async () => {
    mode.value = "min";
    await nextTick();

    expect(document.querySelector("[data-content]")?.textContent).toBe("the content");
    expect(root().className).toContain("workbench-window--min");
    expect(root().getAttribute("aria-hidden")).toBe("true");
  });

  it("drops the radius and the grip when maximised", async () => {
    mode.value = "max";
    await nextTick();

    expect(root().className).toContain("workbench-window--max");
    expect(document.querySelector("[data-workbench-window-grip]")).toBeNull();
  });

  it("applies the closing collapse while the parent removes it", async () => {
    closing.value = true;
    await nextTick();

    expect(root().className).toContain("workbench-window--closing");
  });
});
