/**
 * The cleanup page's own readings, in one place so the spec can question them.
 *
 * The engine's `system df` answers in bytes; the page draws those numbers and, beside each one, a
 * bar of how much of that footprint the engine says it could give back. The bar is a MiniBar and
 * the tier is the desktops' own — `usageTone` names it — so a column of these reads green, amber
 * and red on the same cuts every other gauge answers to. Nothing here decides what a prune may
 * take: that is the tiers' own checkboxes and the confirm behind them.
 */

/**
 * The engine's own size sentences use decimal units (`1.634GB` is 1_634_000_000 bytes), so the
 * page answers in the same units it read in — a row that said 1.634GB does not come back as
 * 1.5GiB, which would look like the engine lost a few megabytes it never had.
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) {
    return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  }
  if (bytes >= 1_000_000) {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
  }
  if (bytes >= 1_000) {
    return `${(bytes / 1_000).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

/**
 * How much of one kind's footprint the engine says it could give back, as a percent for the bar.
 * A kind that occupies nothing has no share to draw — the reading is zero, and a zero footprint is
 * a calm bar, not a missing one.
 */
export function reclaimablePercent(row: { size: number; reclaimable: number }): number {
  if (row.size <= 0) {
    return 0;
  }
  return Math.min(100, Math.round((row.reclaimable / row.size) * 100));
}

/** The total the engine says one run of the checked tiers could give back, before anything runs. */
export function reclaimableTotal(rows: readonly { reclaimable: number }[]): number {
  return rows.reduce((total, row) => total + row.reclaimable, 0);
}
