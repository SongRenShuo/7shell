/**
 * The concurrency helper's own contract: order kept, limit kept, empty answered, one worker's
 * refusal not left dangling as a second unhandled one.
 */
import { describe, expect, it } from "vitest";

import { runLimited } from "@/lib/concurrency";

const beat = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("runLimited", () => {
  it("answers in the input's order, whatever order the workers finished in", async () => {
    const answers = await runLimited([1, 2, 3], 3, async (item) => {
      // The first item is the slowest, so the finish order is 3, 2, 1 — the result order is not.
      await beat((4 - item) * 10);
      return item * 2;
    });
    expect(answers).toEqual([2, 4, 6]);
  });

  it("never keeps more than the limit in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    await runLimited([1, 2, 3, 4, 5, 6, 7], 3, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await beat(5);
      inFlight -= 1;
    });
    expect(peak).toBe(3);
  });

  it("answers an empty list with an empty list", async () => {
    const answers = await runLimited([], 4, async () => 1);
    expect(answers).toEqual([]);
  });

  it("runs a list shorter than the limit without inventing lanes that never see work", async () => {
    const seen: number[] = [];
    await runLimited([1, 2], 8, async (item) => {
      seen.push(item);
      return item;
    });
    expect(seen).toEqual([1, 2]);
  });

  it("carries the first worker's refusal as the run's answer", async () => {
    await expect(
      runLimited([1, 2], 2, async (item) => {
        if (item === 1) {
          await beat(5);
          throw new Error("first item refused");
        }
        await beat(50);
        throw new Error("second item refused later");
      }),
    ).rejects.toThrow("first item refused");
  });
});
