/**
 * The numbers the Docker overview draws, computed where they can be tested.
 *
 * The engine's stats answer is per-container and instantaneous; the overview wants three series —
 * total CPU, total memory pressure, and the network moving through the engine — sampled every few
 * seconds and drawn as three short lines. Nothing here animates: a live chart is data arriving on
 * an interval, and a transition would redraw the past.
 */
import type { ContainerStats } from "@/types/container";

/** How often the overview asks the engine for stats. the reference's own cadence for the same page. */
export const SAMPLE_INTERVAL_MS = 5_000;

/** How many samples each line keeps. Thirty fives are two and a half minutes of history. */
export const SERIES_POINTS = 30;

/** The chart's own size, the reference's mini AreaChart measure. */
export const SPARKLINE_WIDTH = 290;
export const SPARKLINE_HEIGHT = 74;

/** One sampled moment: the three things the overview tracks, already totalled across containers. */
export interface EngineSample {
  readonly cpuPercent: number;
  readonly memoryPercent: number;
  readonly netBytesPerSecond: number;
}

/** Sums one stats answer across every container the engine reported. */
export interface StatsTotals {
  readonly cpuPercent: number;
  readonly memoryPercent: number;
  /** Cumulative bytes the engine has moved; the rate is this sample's delta over the interval. */
  readonly netBytes: number;
}

/** Sums one stats answer across every container the engine reported. */
export function aggregateStats(stats: readonly ContainerStats[]): StatsTotals {
  let cpu = 0;
  let memory = 0;
  let net = 0;
  for (const stat of stats) {
    cpu += stat.cpuPercent;
    memory += stat.memoryPercent;
    net += stat.networkInput + stat.networkOutput;
  }
  return { cpuPercent: cpu, memoryPercent: memory, netBytes: net };
}

/**
 * The network rate between two samples.
 *
 * The engine reports cumulative bytes, so the rate is theirs over the seconds between them. A
 * first sample has no earlier one to differ from, and a clock that ran backwards (or an engine
 * answering out of order) has nothing honest to say: both draw zero rather than a spike.
 */
export function netRate(currentBytes: number, previousBytes: number | null, seconds: number): number {
  if (previousBytes === null || seconds <= 0) {
    return 0;
  }
  return Math.max(0, (currentBytes - previousBytes) / seconds);
}

/**
 * The points string a line is drawn with, normalized to the tallest value in its own series.
 *
 * An all-zero series draws a flat line on the floor rather than a division by zero; fewer than two
 * points draws nothing, because a line of one point is an invisible dot that reads as a glitch.
 */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length < 2) {
    return "";
  }
  const max = Math.max(...values, 0);
  const peak = max > 0 ? max : 1;
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / peak) * (height - 2) - 1;
      return `${round(x)},${round(y)}`;
    })
    .join(" ");
}

function round(value: number): string {
  return value.toFixed(1);
}

/**
 * Whether the engine is healthy: nothing is dead. An engine that answered with no containers at
 * all is healthy too — nothing running is not an unhealthy engine, and the summary rows say so.
 */
export function engineHealthy(states: readonly string[]): boolean {
  return !states.some((state) => state === "dead" || state === "error");
}
