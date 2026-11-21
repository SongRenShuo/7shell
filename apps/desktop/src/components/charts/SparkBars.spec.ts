/**
 * The bar row, as the vocabulary draws it: one bar per sample, every series on one shared scale,
 * and never a line.
 *
 * The rulings this suite pins are the ones the monitor's chart carried into the vocabulary layer:
 * the scale is the tallest value across every series, so a quiet series is visibly quieter than a
 * busy one; the form is bars, because a line would claim the space between the samples was
 * measured; and an empty history keeps the row's height, so a panel does not jump when the first
 * sample lands.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import SparkBars from "@/components/charts/SparkBars.vue";
import type { SparkSeries } from "@/components/charts/SparkBars.vue";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(props: InstanceType<typeof SparkBars>["$props"]): Promise<void> {
  app = createApp({ render: () => h(SparkBars, props) });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** One bar in the row: the column of the sample named, the bar of the series named. */
function barAt(columnIndex: number, seriesIndex: number): HTMLElement {
  const bar = row().children.item(columnIndex)?.children.item(seriesIndex);
  if (!(bar instanceof HTMLElement)) {
    throw new Error(`no bar at column ${columnIndex} of series ${seriesIndex}`);
  }
  return bar;
}

/** The row itself, found by the name it carries for a reader who cannot see it. */
function row(): HTMLDivElement {
  const found = host?.querySelector<HTMLDivElement>("div[role='img']");
  if (!found) {
    throw new Error(`no chart row is drawn: ${host?.textContent}`);
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

describe("the bar row", () => {
  it("draws one column per sample, each series a bar within it", async () => {
    const series: SparkSeries[] = [
      { values: [1, 2, 3], class: "bg-primary/70" },
      { values: [1, 1, 1], class: "bg-muted-foreground/40" },
    ];
    await mount({ series, label: "traffic" });

    const columns = row().children;
    expect(columns, "one column per sample").toHaveLength(3);
    for (const column of columns) {
      expect(column.children, "one bar per series").toHaveLength(2);
    }
  });

  it("scales every series against the tallest value on screen, not against itself", async () => {
    const series: SparkSeries[] = [
      { values: [1, 2, 3], class: "bg-primary/70" },
      { values: [1, 1, 1], class: "bg-muted-foreground/40" },
    ];
    await mount({ series, label: "traffic" });

    expect(barAt(2, 0).style.height, "the sample that is the peak fills the row").toBe("100%");
    expect(barAt(0, 1).style.height, "the quiet series is visibly quieter at the same scale").toBe("33%");
  });

  it("pads a series that is shorter than its neighbour with nothing, not with a fake bar", async () => {
    const series: SparkSeries[] = [
      { values: [2, 4], class: "bg-primary/70" },
      { values: [1], class: "bg-primary/40" },
    ];
    await mount({ series, label: "traffic" });

    const missing = barAt(1, 1);
    expect(missing.style.height, "the sample that never arrived draws zero height").toBe("0%");
  });

  it("keeps its height across an empty history, and draws no bars for it", async () => {
    const series: SparkSeries[] = [{ values: [], class: "bg-primary/70" }];
    await mount({ series, label: "traffic" });

    expect(row().children).toHaveLength(0);
    expect(row().classList.contains("h-10"), "the row stands at its own height, ready").toBe(true);
  });

  it("is a row of bars, never a line", async () => {
    const series: SparkSeries[] = [{ values: [1, 2, 3], class: "bg-primary/70" }];
    await mount({ series, label: "traffic" });

    expect(row().querySelector("svg"), "no svg is drawn").toBeNull();
    expect(row().querySelector("path"), "and no path either — the samples are intervals").toBeNull();
  });

  it("says what it shows to a reader who cannot see it", async () => {
    await mount({ series: [], label: "network rate" });

    expect(row().getAttribute("aria-label")).toBe("network rate");
  });
});
