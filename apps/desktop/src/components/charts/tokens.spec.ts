/**
 * The vocabulary layer's two non-negotiables, read from the source the way the workbench token
 * guard reads the stylesheet:
 *
 * 1. **Every colour a chart can wear is a `var(--…)` reference.** No hex, no functional colour
 *    form, anywhere — the palette layers own what the colours look like, and a literal here would
 *    be a colour that stops answering to any of them. This is the closeout grep, made permanent.
 * 2. **The threshold tiers resolve through the one entry.** The tier tokens are the theme's
 *    success/warning/destructive (and the workbench family's, for what stands on a picture); no
 *    chart may name a tier colour that bypasses them, and none names a threshold of its own.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { TONE_TOKENS, TONE_WORKBENCH } from "@/components/charts/tone";

/** The directory the vocabulary lives in, beside this spec. */
const CHARTS_DIR = join(import.meta.dirname);

/** A hex literal, the shape the closeout grep looks for: a hash and three to eight hex digits. */
const HEX = /#[0-9a-fA-F]{3,8}/;
/** A functional colour in either of its two arities — the triplets belong to the token layers, not to a chart. */
const FUNCTIONAL = /rgba?\(/;

describe("the chart vocabulary's colour discipline", () => {
  it("names every colour as a var() reference — no hex, no functional colour, anywhere", () => {
    const sources = readdirSync(CHARTS_DIR)
      .filter((name) => name.endsWith(".vue") || name.endsWith(".ts"))
      .map((name) => ({ name, text: readFileSync(join(CHARTS_DIR, name), "utf8") }));

    expect(sources.length, "the vocabulary's sources are all read").toBeGreaterThan(0);
    for (const { name, text } of sources) {
      expect(HEX.test(text), `${name} carries a hex literal`).toBe(false);
      expect(FUNCTIONAL.test(text), `${name} carries a functional colour`).toBe(false);
    }
  });

  it("resolves the tiers to the tokens that say what they mean", () => {
    expect(TONE_TOKENS.accent).toBe("var(--workbench-accent)");
    expect(TONE_TOKENS.ok).toBe("var(--success)");
    expect(TONE_TOKENS.warn).toBe("var(--warning)");
    expect(TONE_TOKENS.danger).toBe("var(--destructive)");
  });

  it("resolves the workbench tiers to the family that reads on a picture", () => {
    expect(TONE_WORKBENCH.ok).toBe("var(--workbench-success)");
    expect(TONE_WORKBENCH.warn).toBe("var(--workbench-warning)");
    expect(TONE_WORKBENCH.danger).toBe("var(--workbench-danger)");
  });

  it("never hands a chart a colour that is not a var() reference", () => {
    for (const token of [...Object.values(TONE_TOKENS), ...Object.values(TONE_WORKBENCH)]) {
      expect(token.startsWith("var(--"), `${token} is a reference, not a colour`).toBe(true);
    }
  });
});
