/**
 * The tones the chart primitives wear, and the one threshold behind them.
 *
 * Whether a reading is calm, warm or critical is not each chart's opinion: the desktops share one
 * pair of cuts — ninety wears amber, ninety-five wears red — and `usageTone` is where they live.
 * The primitives take a tone and resolve it against the theme's tokens, so no component carries a
 * colour of its own and none carries a threshold of its own either: a chart that wanted its own
 * eighty would have to bypass this module to get one, and nothing here offers the bypass.
 */
import { usageTone } from "@/lib/workbench/desktopWidgets";

export { usageTone };

/** The visual tones a primitive can wear. `accent` is a series' own colour, not a threshold. */
export type ChartTone = "accent" | "ok" | "warn" | "danger";

/**
 * The tokens the tiers resolve to, for the window content that reads the interface's theme. Every
 * value is a `var(--…)` reference — the palette layer owns what the colours look like, and this
 * record owns only what they mean.
 */
export const TONE_TOKENS: Record<ChartTone, string> = {
  accent: "var(--workbench-accent)",
  ok: "var(--success)",
  warn: "var(--warning)",
  danger: "var(--destructive)",
};

/**
 * The same tiers for the desktop chrome — the widgets and surfaces drawn on the desk's own glass or
 * on a picture, where the theme's tokens do not follow and the workbench family does. The pairing
 * rule is the wallpaper line's: text standing on a picture is white, whatever the host's theme says,
 * so the threshold colours it can wear come from here and not from the theme above.
 */
export const TONE_WORKBENCH: Record<"ok" | "warn" | "danger", string> = {
  ok: "var(--workbench-success)",
  warn: "var(--workbench-warning)",
  danger: "var(--workbench-danger)",
};
