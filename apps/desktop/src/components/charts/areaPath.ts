/**
 * The geometry one area chart is drawn with, kept where it can be tested without a component.
 *
 * The measure is the reference mini area chart's, the same the container window's lines were drawn
 * at; the maths normalizes the series to the tallest value it holds, so a quiet series fills its
 * box rather than drowning in it.
 */

/** The chart's own size, the reference mini area chart's measure. */
export const SPARK_WIDTH = 290;
export const SPARK_HEIGHT = 74;

/** The two paths an area chart is drawn with: the filled band and the edge it is read by. */
export interface AreaPaths {
  /** The baseline-closed shape the fill is painted on, ending in `Z` so the band seals itself. */
  readonly area: string;
  /** The top edge itself, stroked on top of the fill so the trend reads at a glance. */
  readonly line: string;
}

/**
 * The paths for one series, oldest first.
 *
 * Fewer than two points draws nothing — a line of one point is an invisible dot that reads as a
 * glitch — and an all-zero series draws a flat band on the floor rather than a division by zero.
 * The edge is stroked, but the form is the area: a bare line would claim the space between the
 * samples was measured, and it was not.
 */
export function areaPaths(
  values: readonly number[],
  width: number = SPARK_WIDTH,
  height: number = SPARK_HEIGHT,
): AreaPaths | null {
  if (values.length < 2) {
    return null;
  }
  const max = Math.max(...values, 0);
  const peak = max > 0 ? max : 1;
  const step = width / (values.length - 1);
  const points = values.map((value, index) => {
    const x = index * step;
    const y = height - (value / peak) * (height - 2) - 1;
    return `${round(x)},${round(y)}`;
  });
  const line = `M ${points.join(" L ")}`;
  const floor = round(height - 1);
  return {
    line,
    area: `${line} L ${round(width)},${floor} L 0,${floor} Z`,
  };
}

function round(value: number): string {
  return value.toFixed(1);
}
