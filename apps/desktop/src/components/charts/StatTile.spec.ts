/**
 * The stat tile, as the vocabulary draws it: a named reading at the one large size the interface
 * allows, wearing the tier the reading earns, with its own recent history as a quiet band behind
 * the number.
 *
 * The tier colours belong to the number, not the band — a calm reading keeps the foreground (the
 * way the desk widgets' values already do), amber and red say "look here", and the band stays
 * context in the muted ink whatever the reading earns.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import StatTile from "@/components/charts/StatTile.vue";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(props: InstanceType<typeof StatTile>["$props"]): Promise<void> {
  app = createApp({ render: () => h(StatTile, props) });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** The paragraph the reading is set in. */
function valueParagraph(): HTMLParagraphElement {
  const found = [...host!.querySelectorAll("p")].find((p) => p.classList.contains("nums"));
  if (!found) {
    throw new Error(`no reading is drawn: ${host?.textContent}`);
  }
  return found;
}

/** The band behind the number, if one is drawn. */
function band(): HTMLElement | null {
  return host?.querySelector("[aria-hidden='true']") ?? null;
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

describe("the stat tile", () => {
  it("names the reading above the reading itself", async () => {
    await mount({ label: "memory", value: "6.2 GB / 16 GB" });

    expect(host?.textContent).toContain("memory");
    expect(valueParagraph().textContent?.trim()).toBe("6.2 GB / 16 GB");
  });

  it("wears the numeric track for its reading", async () => {
    await mount({ label: "memory", value: "6.2 GB / 16 GB" });

    expect(valueParagraph().classList.contains("nums")).toBe(true);
  });

  it.each([
    ["warn", "var(--warning)"],
    ["danger", "var(--destructive)"],
  ] as const)("wears the tier's colour when the reading earns it: %s", async (tone, token) => {
    await mount({ label: "memory", value: "92%", tone });

    expect(valueParagraph().style.color).toBe(token);
  });

  it("keeps the foreground for a calm reading, the way the widgets' values do", async () => {
    await mount({ label: "memory", value: "40%", tone: "ok" });

    expect(valueParagraph().style.color).toBe("");
  });

  it("draws the reading's own history as a band, scaled to the tallest value it holds", async () => {
    await mount({ label: "cpu", value: "30%", series: [1, 3, 2] });

    const bars = band()?.querySelectorAll("span");
    if (!bars) {
      throw new Error("no band is drawn");
    }
    expect(bars, "one bar per sample").toHaveLength(3);
    expect((bars[1] as HTMLElement).style.height, "the peak fills the band").toBe("100%");
    expect((bars[0] as HTMLElement).style.height, "the trough keeps its share").toBe("33%");
  });

  it("draws no band for a history too young to be one", async () => {
    await mount({ label: "cpu", value: "30%", series: [5] });

    expect(band()).toBeNull();
  });

  it("draws no band when there is no history at all", async () => {
    await mount({ label: "cpu", value: "30%" });

    expect(band()).toBeNull();
  });
});
