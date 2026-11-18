/**
 * The status tag: a state on its own colour.
 *
 * What is asserted is the contract the container list leans on — that the four tones exist and are
 * distinct, that an unset tone is the neutral one (an unknown state is never guessed at a colour),
 * and that the wash is mixed from the theme's semantic colour rather than painted literal, so the
 * same tag reads in either theme.
 */
import { type App, createApp, h } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import WbTag, { type WbTagTone } from "@/components/ui/WbTag.vue";

let app: App | undefined;
let host: HTMLDivElement;

function mount(tone?: WbTagTone, label = "running"): HTMLElement {
  app = createApp({
    render() {
      return h(WbTag, { tone }, () => label);
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  return host.querySelector("[data-wb-tag]") as HTMLElement;
}

function reset(): void {
  app?.unmount();
  host?.remove();
}

beforeEach(reset);
afterEach(reset);

describe("the four tones", () => {
  it("draws each state family on its own meaning colour", () => {
    const expectations: Record<WbTagTone, string> = {
      success: "var(--success)",
      danger: "var(--destructive)",
      warning: "var(--warning)",
      neutral: "var(--muted-foreground)",
    };
    for (const [tone, colour] of Object.entries(expectations) as [WbTagTone, string][]) {
      const tag = mount(tone);
      expect(tag.className, `${tone} names itself`).toContain(`wb-tag--${tone}`);
      expect(tag.getAttribute("style"), `${tone} mixes from the theme's colour`).toContain(colour);
      reset();
    }
  });

  it("defaults to neutral: a state nobody named is not guessed at a colour", () => {
    const tag = mount(undefined, "unheard-of");
    expect(tag.className).toContain("wb-tag--neutral");
    expect(tag.textContent).toBe("unheard-of");
  });

  it("marks itself so a table cell or a summary can find the state it drew", () => {
    const tag = mount("success");
    expect(tag.hasAttribute("data-wb-tag")).toBe(true);
  });
});
