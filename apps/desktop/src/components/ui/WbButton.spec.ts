/**
 * The shared button, as the panes meet it: three intents and two sizes, and the busy state that
 * turns a write action's button into a "something is happening" while the operation's own words
 * are still what the label says.
 *
 * What is asserted is what stops being free once the intents are shared: that the variants carry
 * the theme tokens rather than literals, that busy refuses presses while ordinary disabled does
 * not draw a spinner, and that a button still answers a click when it is enabled.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, expect, it } from "vitest";

import WbButton from "@/components/ui/WbButton.vue";

let app: App | undefined;
let host: HTMLDivElement;
let clicks: number[] = [];

type Props = {
  variant?: "primary" | "secondary" | "ghost";
  size?: "sm" | "md";
  busy?: boolean;
  disabled?: boolean;
};

function mount(props: Props = {}): HTMLButtonElement {
  clicks = [];
  app = createApp({
    render() {
      return h(WbButton, { ...props, onClick: () => clicks.push(clicks.length) }, () => "Do it");
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  return host.querySelector("button") as HTMLButtonElement;
}

function reset(): void {
  app?.unmount();
  host?.remove();
}

beforeEach(reset);
afterEach(reset);

it("draws the label and the default intent — a secondary, medium button", () => {
  const button = mount();
  expect(button.textContent).toBe("Do it");
  expect(button.className).toContain("border-border");
  expect(button.className).toContain("text-xs");
});

it("keeps one base shape while the intent changes the fill", () => {
  const primary = mount({ variant: "primary" });
  expect(primary.className).toContain("bg-primary");
  expect(primary.className).toContain("focus-visible:ring-1");

  reset();
  const ghost = mount({ variant: "ghost" });
  expect(ghost.className).toContain("border-transparent");
  expect(ghost.className).toContain("focus-visible:ring-1");
});

it("sizes from the interface's own two text steps, not new ones", () => {
  const small = mount({ size: "sm" });
  expect(small.className).toContain("text-[11px]");

  reset();
  const medium = mount({ size: "md" });
  expect(medium.className).toContain("text-xs");
});

it("busy means the operation is in flight: a spinner, an announcement, and no press", async () => {
  const button = mount({ busy: true });
  expect(button.disabled, "busy refuses presses").toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  expect(button.querySelector(".animate-spin"), "the spinner is drawn").not.toBeNull();

  button.click();
  await nextTick();
  expect(clicks, "a busy button answers nothing").toEqual([]);
});

it("disabled is dimmed and inert, but draws no spinner", () => {
  const button = mount({ disabled: true });
  expect(button.disabled).toBe(true);
  expect(button.getAttribute("aria-busy"), "disabled is not busy").toBeNull();
  expect(button.querySelector(".animate-spin")).toBeNull();
});

it("a live button answers its click", () => {
  const button = mount();
  button.click();
  expect(clicks).toEqual([0]);
});

it("stays a plain button — never a submit inside somebody's form", () => {
  const button = mount({ variant: "primary" });
  expect(button.getAttribute("type")).toBe("button");
});
