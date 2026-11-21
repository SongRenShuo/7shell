/**
 * The mini bar, as the vocabulary draws it: a cell's capacity bar, tiered by the desktops' shared
 * cuts and painted by the theme's tokens.
 *
 * A column of these reads green, amber and red on the same ninety/ninety-five every other gauge
 * answers to — and a row whose reading never arrived draws the dash, never a bar somebody would
 * take for an empty disk.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import MiniBar from "@/components/charts/MiniBar.vue";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(props: InstanceType<typeof MiniBar>["$props"]): Promise<void> {
  app = createApp({ render: () => h(MiniBar, props) });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** The bar's track, with the fill inside it. */
function track(): HTMLElement {
  const found = host?.querySelector<HTMLElement>("span[role='img']");
  if (!found) {
    throw new Error(`no bar is drawn: ${host?.textContent}`);
  }
  return found;
}

beforeEach(() => {
  host = undefined;
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
});

describe("the mini bar", () => {
  it("fills the track by the share the percent is, in the tier's token", async () => {
    await mount({ percent: 50, label: "root" });

    const fill = track().firstElementChild as HTMLElement;
    expect(fill.style.width).toBe("50%");
    expect(fill.style.background).toBe("var(--success)");
  });

  it.each([
    [89, "var(--success)"],
    [92, "var(--warning)"],
    [96, "var(--destructive)"],
  ] as const)("tiers the fill the way the desktops share: %i%% paints %s", async (percent, token) => {
    await mount({ percent, label: "root" });

    expect((track().firstElementChild as HTMLElement).style.background).toBe(token);
  });

  it("clamps a percent outside the ruler to the ruler", async () => {
    await mount({ percent: -5, label: "root" });
    expect((track().firstElementChild as HTMLElement).style.width).toBe("0%");

    await mount({ percent: 150, label: "root" });
    expect((track().firstElementChild as HTMLElement).style.width).toBe("100%");
  });

  it("draws the dash for a reading that never arrived, not an empty bar", async () => {
    await mount({ percent: null, label: "root" });

    expect(host?.querySelector("span[role='img']"), "no track is drawn").toBeNull();
    expect(host?.textContent).toContain("—");
  });

  it("says what it is of to a reader who cannot see it", async () => {
    await mount({ percent: 50, label: "root, half full" });

    expect(track().getAttribute("aria-label")).toBe("root, half full");
  });
});
