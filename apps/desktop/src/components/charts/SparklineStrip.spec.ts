/**
 * The widgets' trend strip, as the vocabulary draws it: one thin row of bars, coloured only from
 * the workbench family.
 *
 * The colour rule is the suite's spine, because the strip stands on the desk — on glass, on a
 * picture — where the theme's semantic colours do not follow: a theme green on a pale wallpaper is
 * the colour that stops being visible. Both tones the strip can wear resolve to `--workbench-*`
 * tokens, and no other colour can reach it.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SparklineStrip from "@/components/charts/SparklineStrip.vue";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(props: InstanceType<typeof SparklineStrip>["$props"]): Promise<void> {
  app = createApp({ render: () => h(SparklineStrip, props) });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** The strip itself, found by the name it carries for a reader who cannot see it. */
function strip(): HTMLDivElement {
  const found = host?.querySelector<HTMLDivElement>("div[role='img']");
  if (!found) {
    throw new Error(`no strip is drawn: ${host?.textContent}`);
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

describe("the trend strip", () => {
  it("draws one bar per sample, scaled to the tallest value it holds", async () => {
    await mount({ values: [1, 2], label: "cpu" });

    const bars = strip().children;
    expect(bars, "one bar per sample").toHaveLength(2);
    expect((bars[0] as HTMLElement).style.height, "the trough keeps its share").toBe("50%");
    expect((bars[1] as HTMLElement).style.height, "the peak fills the strip").toBe("100%");
  });

  it("wears the accent for a series the desk is watching", async () => {
    await mount({ values: [1, 2], label: "cpu" });

    expect((strip().children[0] as HTMLElement).style.background).toBe("var(--workbench-accent)");
  });

  it("wears the muted step when the series yields to the card beside it", async () => {
    await mount({ values: [1, 2], label: "cpu", tone: "muted" });

    expect((strip().children[0] as HTMLElement).style.background).toBe("var(--workbench-on-picture-muted)");
  });

  it("is coloured by nothing outside the workbench family — it stands on a picture", async () => {
    await mount({ values: [1, 2], label: "cpu" });
    await mount({ values: [1, 2], label: "cpu", tone: "muted" });

    for (const bar of strip().children) {
      expect((bar as HTMLElement).style.background.startsWith("var(--workbench-")).toBe(true);
    }
  });

  it("keeps its height across an empty history, and draws no bars for it", async () => {
    await mount({ values: [], label: "cpu" });

    expect(strip().children).toHaveLength(0);
    expect(strip().classList.contains("h-6"), "the strip stands at its own height, ready").toBe(true);
  });

  it("says what it shows to a reader who cannot see it", async () => {
    await mount({ values: [1, 2], label: "cpu, last minute" });

    expect(strip().getAttribute("aria-label")).toBe("cpu, last minute");
  });
});
