/**
 * The ring gauge, as the vocabulary draws it: one arc saying how full something is, painted in the
 * tier the desktops share.
 *
 * The tiers are the suite's spine: below ninety the success token, ninety to ninety-four the
 * warning token the panel's old inline ring never had (it went straight to red at ninety), and
 * ninety-five and past it the destructive token. The gauge keeps no threshold of its own — it asks
 * `usageTone`, the same entry every other gauge asks.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import RingGauge from "@/components/charts/RingGauge.vue";

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mount(props: InstanceType<typeof RingGauge>["$props"]): Promise<void> {
  app = createApp({ render: () => h(RingGauge, props) });
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** The track circle first, the reading's arc second — or the track alone. */
function circles(): NodeListOf<SVGCircleElement> {
  const svg = host?.querySelector("svg");
  if (!svg) {
    throw new Error(`no ring is drawn: ${host?.textContent}`);
  }
  return svg.querySelectorAll("circle");
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

describe("the ring gauge", () => {
  it.each([
    [89, "var(--success)"],
    [92, "var(--warning)"],
    [96, "var(--destructive)"],
  ] as const)("wears the tier the desktops share at %i%%: %s", async (percent, token) => {
    await mount({ percent });

    expect(circles()[1]?.getAttribute("stroke"), "the arc wears the tier's token").toBe(token);
  });

  it("keeps the track behind the arc, in a token of its own", async () => {
    await mount({ percent: 50 });

    expect(circles()[0]?.getAttribute("stroke")).toBe("var(--accent)");
    expect(circles()[0]?.getAttribute("stroke-dasharray"), "the track is whole").toBeNull();
  });

  it("draws the arc as the share the percent is of the whole ring", async () => {
    await mount({ percent: 50 });

    expect(circles()[1]?.getAttribute("stroke-dasharray")).toBe("56.55 113.10");
  });

  it("clamps a reading past the whole ring to the whole ring", async () => {
    await mount({ percent: 120 });

    expect(circles()[1]?.getAttribute("stroke-dasharray")).toBe("113.10 113.10");
  });

  it("draws the track alone for a subject that answered nothing", async () => {
    await mount({ percent: null });

    expect(circles(), "no arc is drawn for no reading").toHaveLength(1);
  });

  it("hides itself from a reader who has the caption, and labels itself when there is none", async () => {
    await mount({ percent: 50 });

    const unlabelled = host?.querySelector("svg");
    expect(unlabelled?.getAttribute("aria-hidden")).toBe("true");
    expect(unlabelled?.getAttribute("role")).toBeNull();

    await mount({ percent: 50, label: "root, 50 percent full" });
    const labelled = host?.querySelector("svg");
    expect(labelled?.getAttribute("role")).toBe("img");
    expect(labelled?.getAttribute("aria-label")).toBe("root, 50 percent full");
  });
});
