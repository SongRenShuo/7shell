/**
 * The empty state: one drawing per scene, in three sizes, that says only what it is handed.
 *
 * What is asserted is the contract the callers lean on — that every scene in the reference's five
 * has a drawing, that the size tiers are the reference's own pixel widths, that the words arrive
 * from the caller (an empty trash and an empty mirror list are named where they are emptied, not
 * here), and that the line-work takes the inherited colour rather than a literal, so the same
 * component reads inside a window on a wallpaper and on a theme surface.
 */
import { type App, createApp, h } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import WbEmpty, { WB_EMPTY_SCENARIOS, WB_EMPTY_SIZES, type WbEmptyScenario } from "@/components/ui/WbEmpty.vue";

let app: App | undefined;
let host: HTMLDivElement;

function mount(scenario: WbEmptyScenario, extra: Record<string, unknown> = {}): HTMLElement {
  app = createApp({
    render() {
      return h(WbEmpty, { scenario, ...extra });
    },
  });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  return host.querySelector("[data-wb-empty]") as HTMLElement;
}

function reset(): void {
  app?.unmount();
  host?.remove();
}

beforeEach(reset);
afterEach(reset);

describe("the five scenes", () => {
  it("draws a distinct illustration for each scene the reference names", () => {
    for (const scenario of WB_EMPTY_SCENARIOS) {
      const empty = mount(scenario);
      expect(empty.dataset.scenario, `${scenario} names itself`).toBe(scenario);
      expect(empty.querySelector("[data-wb-empty-art]"), `${scenario} draws`).not.toBeNull();
      reset();
    }
  });

  it("takes its line colour from what it inherits, not from a literal", () => {
    const empty = mount("noData");
    const strokes = empty.querySelectorAll('[stroke="currentColor"]');
    expect(strokes.length, "the drawing's strokes are the inherited colour").toBeGreaterThan(0);
  });

  it("marks its one decorative flourish with the accent token", () => {
    const empty = mount("loadFailed");
    const flourish = empty.querySelector('[fill="var(--workbench-accent, currentColor)"]');
    expect(flourish, "the accent dot mixes from the token, with a colour fallback").not.toBeNull();
  });
});

describe("the three sizes", () => {
  it("draws the reference's own pixel tiers", () => {
    const expectations: [WbEmptyScenario, keyof typeof WB_EMPTY_SIZES, number][] = [
      ["noData", "sm", WB_EMPTY_SIZES.sm],
      ["noFile", "md", WB_EMPTY_SIZES.md],
      ["noSearchResult", "lg", WB_EMPTY_SIZES.lg],
    ];
    for (const [scenario, size, pixels] of expectations) {
      const empty = mount(scenario, { size });
      expect(empty.dataset.size).toBe(size);
      const svg = empty.querySelector("svg");
      expect(svg?.getAttribute("width")).toBe(String(pixels));
      expect(svg?.getAttribute("height")).toBe(String(pixels));
      reset();
    }
  });

  it("defaults to the middle size", () => {
    const empty = mount("noHardDisk");
    expect(empty.dataset.size).toBe("md");
  });
});

describe("the words", () => {
  it("says what the caller hands it, and nothing when handed nothing", () => {
    const labelled = mount("noData", { title: "Nothing here", description: "The trash is empty" });
    expect(labelled.querySelector("[data-wb-empty-title]")?.textContent).toBe("Nothing here");
    expect(labelled.querySelector("[data-wb-empty-description]")?.textContent).toBe("The trash is empty");
    reset();

    const bare = mount("noData");
    expect(bare.querySelector("[data-wb-empty-title]")).toBeNull();
    expect(bare.querySelector("[data-wb-empty-description]")).toBeNull();
  });
});
