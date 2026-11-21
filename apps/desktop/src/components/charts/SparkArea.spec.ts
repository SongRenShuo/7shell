/**
 * The area chart, as the vocabulary draws it: a band of samples with an edge to read, never a bare
 * line; the tier it wears resolved against the theme's tokens; a series too young to draw saying so
 * with the dash; and — the discipline the whole vocabulary is built on — a chart that stops growing
 * when nobody is looking.
 */
import { type App, createApp, h, nextTick, ref } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import SparkArea from "@/components/charts/SparkArea.vue";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(props: InstanceType<typeof SparkArea>["$props"]): Promise<void> {
  app = createApp({ render: () => h(SparkArea, props) });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** The drawn chart: the panel section, found by its title. */
function chart(): HTMLElement {
  const found = host?.querySelector("section");
  if (!found) {
    throw new Error(`no chart is drawn: ${host?.textContent}`);
  }
  return found;
}

/** The stroked edge — the second of the two paths the area is drawn with. */
function edge(): SVGPathElement | null {
  return chart().querySelectorAll<SVGPathElement>("path")[1] ?? null;
}

beforeEach(() => {
  host = undefined;
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
});

afterEach(() => {
  app?.unmount();
  host?.remove();
  app = undefined;
  host = undefined;
  vi.useRealTimers();
});

describe("the area chart", () => {
  it("draws an area and its edge once the series has two points to span", async () => {
    await mount({ label: "cpu", values: [1, 3, 2] });

    const svg = chart().querySelector("svg");
    if (!svg) {
      throw new Error("the chart draws no svg");
    }
    const paths = svg.querySelectorAll("path");
    expect(paths, "the fill and the edge are two paths").toHaveLength(2);
    const fill = paths.item(0);
    if (!fill) {
      throw new Error("the fill is not drawn");
    }
    expect(fill.getAttribute("d"), "the fill is sealed to the floor").toContain("Z");
  });

  it("is an area, not the polyline the container window used to draw", async () => {
    await mount({ label: "cpu", values: [1, 3, 2] });

    expect(chart().querySelector("polyline"), "no bare line form survives").toBeNull();
    const edge = chart().querySelectorAll<SVGPathElement>("path")[1];
    expect(edge?.getAttribute("fill"), "the edge itself is not filled — the band is").toBe("none");
  });

  it("scales the series to the tallest value it holds", async () => {
    await mount({ label: "cpu", values: [1, 3] });

    expect(edge()?.getAttribute("d"), "the peak reaches the top; the trough keeps its share").toBe(
      "M 0.0,49.0 L 290.0,1.0",
    );
  });

  it("draws a flat band on the floor for an all-zero series, not a division by zero", async () => {
    await mount({ label: "cpu", values: [0, 0, 0] });

    expect(edge()?.getAttribute("d")).toBe("M 0.0,73.0 L 145.0,73.0 L 290.0,73.0");
  });

  it.each([
    ["accent", "var(--workbench-accent)"],
    ["ok", "var(--success)"],
    ["warn", "var(--warning)"],
    ["danger", "var(--destructive)"],
  ] as const)("resolves the tone %s to the token that says what it means", async (tone, token) => {
    await mount({ label: "memory", values: [1, 2], tone });

    expect(edge()?.getAttribute("stroke")).toBe(token);
    expect(chart().querySelector("path")?.getAttribute("fill")).toBe(token);
  });

  it("says a too-young series honestly, with the dash the numbers use", async () => {
    await mount({ label: "cpu", values: [12.5] });

    expect(chart().querySelector("svg")).toBeNull();
    expect(chart().textContent).toContain("—");
  });

  it("shows the reading beside the title as tabular numbers, unit and all", async () => {
    await mount({ label: "network", values: [1, 2], value: "1.2 MB/s" });

    const reading = [...chart().querySelectorAll("span")].find((span) => span.textContent === "1.2 MB/s");
    expect(reading?.classList.contains("nums"), "the reading wears the numeric track").toBe(true);
  });

  it("says what it shows to a reader who cannot see it", async () => {
    await mount({ label: "cpu", values: [1, 2] });

    expect(chart().querySelector("svg")?.getAttribute("aria-label")).toBe("cpu");
  });
});

describe("the sampling discipline", () => {
  /**
   * The chart does not sample — a feeder the way the Docker overview runs one does. The pattern is
   * the overview spec's own: an interval that only asks while the page is visible, stopped outright
   * when the page is hidden. What is new here is the assertion on the drawn shape: the chart's edge
   * stops gaining segments, not just the feeder's calls.
   */
  it("stops growing while the page is hidden, and picks up where it left off when somebody looks again", async () => {
    vi.useFakeTimers();
    const series = ref<number[]>([]);
    app = createApp({ render: () => h(SparkArea, { label: "cpu", values: series.value }) });
    host = document.createElement("div");
    document.body.append(host);
    app.mount(host);

    const INTERVAL = 5_000;
    let timer: ReturnType<typeof setInterval> | null = setInterval(tick, INTERVAL);
    function tick(): void {
      if (document.visibilityState === "visible") {
        series.value = [...series.value, series.value.length + 1];
      }
    }
    function stop(): void {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    }
    function onVisibilityChange(): void {
      if (document.visibilityState === "visible") {
        tick();
        if (timer === null) {
          timer = setInterval(tick, INTERVAL);
        }
        return;
      }
      stop();
    }
    document.addEventListener("visibilitychange", onVisibilityChange);

    const segments = () => ((edge()?.getAttribute("d") ?? "").match(/L /g) ?? []).length;

    await vi.advanceTimersByTimeAsync(INTERVAL * 2);
    await nextTick();
    expect(segments(), "two samples, one edge").toBe(1);

    await vi.advanceTimersByTimeAsync(INTERVAL);
    await nextTick();
    expect(segments(), "the chart grows while somebody is looking").toBe(2);

    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(INTERVAL * 3);
    await nextTick();
    expect(segments(), "and stops growing when nobody can see it").toBe(2);

    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await nextTick();
    expect(segments(), "and picks up where it left off, drawing the sample it takes on return").toBe(3);

    stop();
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });
});
