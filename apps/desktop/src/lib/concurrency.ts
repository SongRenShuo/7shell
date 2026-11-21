/**
 * The one concurrency shape more than one page needs.
 *
 * Two orchestrations in the Docker manager walk a list and ask the engine about each entry — a
 * batch of container writes, a sweep of image update checks. Neither wants to fire the whole list
 * at a daemon that answers one at a time, and neither wants the slowness of one-at-a-time either;
 * a small lane count is the answer both can share.
 *
 * The contract callers sign up to: a worker that throws takes the whole run down, so a caller
 * that wants per-item outcomes catches inside its own worker — both of this app's callers do.
 * The answers come back in the input's order, whatever order the workers finished in, so a
 * summary can be read off the result without re-joining it to the input.
 */

/** How many items one run keeps in flight at most; a list shorter than the cap just runs. */
export const DEFAULT_RUN_LIMIT = 4;

/**
 * Runs `worker` over `items`, at most `limit` at a time, and answers every result in input order.
 *
 * The lanes pull from one shared cursor, so an item that finishes early lets the next one start
 * without waiting for its lane-mates; no lane ever idles while work is left.
 */
export async function runLimited<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let cursor = 0;

  const laneCount = Math.max(1, Math.min(limit, items.length));
  const lanes = Array.from({ length: laneCount }, async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        return;
      }
      results[index] = await worker(items[index] as T, index);
    }
  });

  // A lane that rejects after the first one already sank the run must not surface as an unhandled
  // rejection: the run's answer is the first refusal, and the others are noise around it.
  for (const lane of lanes) {
    void lane.catch(() => {});
  }
  await Promise.all(lanes);
  return results;
}
