/**
 * The shared button, as the panes meet it: four intents and three sizes, and the busy state that
 * turns a write action's button into a "something is happening" while the operation's own words
 * are still what the label says.
 *
 * What is asserted is what stops being free once the intents are shared: that the variants carry
 * the theme tokens rather than literals (the primary is the brand blue, the warn a light wash of
 * danger), that the three heights are the reference's own steps, that the control radius is the
 * corner style's 6px step, and that busy refuses presses while ordinary disabled does not draw a
 * spinner.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, expect, it } from "vitest";

import WbButton from "@/components/ui/WbButton.vue";

let app: App | undefined;
let host: HTMLDivElement;
let clicks: number[] = [];

type Props = {
  variant?: "primary" | "secondary" | "tertiary" | "warn";
  size?: "sm" | "md" | "lg";
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
  expect(button.className, "the white face with an edge").toContain("bg-background");
  expect(button.className).toContain("text-xs");
});

it("keeps one base shape while the intent changes the fill", () => {
  const primary = mount({ variant: "primary" });
  expect(primary.className, "the primary is the desktop's brand-blue token").toContain("bg-[var(--workbench-accent)]");
  expect(primary.className, "the words on the blue are the fixed white pair").toContain(
    "text-[var(--workbench-on-wallpaper)]",
  );
  expect(primary.className).toContain("focus-visible:ring-1");

  reset();
  const tertiary = mount({ variant: "tertiary" });
  expect(tertiary.className).toContain("border-transparent");
  expect(tertiary.className).toContain("bg-muted");
  expect(tertiary.className).toContain("focus-visible:ring-1");

  reset();
  const warn = mount({ variant: "warn" });
  expect(warn.className, "warn is the light wash of danger with the danger colour as its text").toContain(
    "text-[var(--workbench-danger)]",
  );
  expect(warn.className).toContain("bg-[color-mix(in_srgb,var(--workbench-danger)_10%,transparent)]");
});

it("wears the control radius the corner style derives — the 6px step", () => {
  const button = mount({ variant: "primary" });
  expect(button.className).toContain("rounded-sm");
});

it("sizes from the reference's own three heights", () => {
  const small = mount({ size: "sm" });
  expect(small.className).toContain("h-7");
  expect(small.className).toContain("text-[11px]");

  reset();
  const medium = mount({ size: "md" });
  expect(medium.className).toContain("h-9");
  expect(medium.className).toContain("text-xs");

  reset();
  const large = mount({ size: "lg" });
  expect(large.className).toContain("h-10");
  expect(large.className).toContain("text-sm");
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
