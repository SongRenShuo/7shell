/**
 * The overview's arithmetic, without the component: what the three lines draw, what the rate
 * between two samples is, and whether the engine is healthy.
 *
 * These are the parts that would be silently wrong in a chart — a peak that divides by zero on a
 * quiet engine, a backwards clock that draws a negative spike, a cumulative counter read as a
 * rate — so each is pinned here rather than in a DOM assertion.
 */
import { describe, expect, it } from "vitest";

import {
  SAMPLE_INTERVAL_MS,
  SERIES_POINTS,
  SPARKLINE_HEIGHT,
  SPARKLINE_WIDTH,
  aggregateStats,
  engineHealthy,
  netRate,
  sparklinePoints,
} from "@/components/container/dockerMetrics";
import type { ContainerStats, ContainerSummary } from "@/types/container";

/** A container row reduced to what the health lamp reads. */
function row(state: string, health?: string): Pick<ContainerSummary, "state" | "health"> {
  return { state, health };
}

function stat(partial: Partial<ContainerStats>): ContainerStats {
  return {
    id: "c1",
    name: "one",
    cpuPercent: 0,
    memoryUsage: 0,
    memoryLimit: 0,
    memoryPercent: 0,
    networkInput: 0,
    networkOutput: 0,
    blockInput: 0,
    blockOutput: 0,
    pids: 0,
    ...partial,
  };
}

describe("aggregating a stats answer", () => {
  it("sums every container the engine reported", () => {
    const totals = aggregateStats([
      stat({ cpuPercent: 1.5, memoryPercent: 10, networkInput: 100, networkOutput: 50 }),
      stat({ cpuPercent: 2.5, memoryPercent: 5, networkInput: 200, networkOutput: 25 }),
    ]);

    expect(totals.cpuPercent).toBeCloseTo(4);
    expect(totals.memoryPercent).toBeCloseTo(15);
    expect(totals.netBytes).toBe(375);
  });

  it("sums an empty engine to zeros rather than NaN", () => {
    expect(aggregateStats([])).toEqual({ cpuPercent: 0, memoryPercent: 0, netBytes: 0 });
  });
});

describe("the network rate", () => {
  it("is the delta of the cumulative counters over the seconds between samples", () => {
    expect(netRate(375, 75, 5)).toBe(60);
  });

  it("has no first rate: a sample with no earlier one draws zero", () => {
    expect(netRate(375, null, 5)).toBe(0);
  });

  it("never draws a spike from a counter that went backwards", () => {
    expect(netRate(10, 500, 5)).toBe(0);
    expect(netRate(100, 50, 0)).toBe(0);
  });

  it("samples every five seconds", () => {
    expect(SAMPLE_INTERVAL_MS).toBe(5_000);
  });
});

describe("the sparkline", () => {
  it("draws in the the reference mini chart's measure", () => {
    expect(SPARKLINE_WIDTH).toBe(290);
    expect(SPARKLINE_HEIGHT).toBe(74);
  });

  it("normalizes to the series' own peak, inside the frame", () => {
    const points = sparklinePoints([0, 50, 100], SPARKLINE_WIDTH, SPARKLINE_HEIGHT).split(" ");
    expect(points).toHaveLength(3);
    const first = points[0]?.split(",") ?? [];
    const last = points[2]?.split(",") ?? [];
    expect(Number(first[1]), "higher values draw higher").toBeGreaterThan(Number(last[1]));
    for (const point of points) {
      const [, y] = point.split(",");
      expect(Number(y)).toBeGreaterThanOrEqual(0);
      expect(Number(y)).toBeLessThanOrEqual(SPARKLINE_HEIGHT);
    }
  });

  it("draws a flat line on the floor for an all-zero series, not a division by zero", () => {
    const points = sparklinePoints([0, 0, 0, 0], SPARKLINE_WIDTH, SPARKLINE_HEIGHT);
    expect(points).not.toContain("NaN");
    expect(points).not.toContain("Infinity");
  });

  it("draws nothing for fewer than two points", () => {
    expect(sparklinePoints([42], SPARKLINE_WIDTH, SPARKLINE_HEIGHT)).toBe("");
    expect(sparklinePoints([], SPARKLINE_WIDTH, SPARKLINE_HEIGHT)).toBe("");
  });

  it("keeps the series short enough to stay a line, not a log", () => {
    expect(SERIES_POINTS).toBeLessThanOrEqual(60);
  });
});

describe("the health lamp", () => {
  it("is healthy while nothing is dead", () => {
    expect(engineHealthy([row("running"), row("exited"), row("paused")])).toBe(true);
    expect(engineHealthy([])).toBe(true);
  });

  it("goes unhealthy on a dead or errored container", () => {
    expect(engineHealthy([row("running"), row("dead")])).toBe(false);
    expect(engineHealthy([row("error")])).toBe(false);
  });

  it("a failing healthcheck inside a running container is an unhealthy engine too", () => {
    expect(engineHealthy([row("running", "healthy")])).toBe(true);
    expect(engineHealthy([row("running", "starting")])).toBe(true);
    expect(engineHealthy([row("running", "unhealthy")])).toBe(false);
    // The verdict means nothing on a container that is not running to begin with.
    expect(engineHealthy([row("exited", "unhealthy")])).toBe(true);
  });
});
