/**
 * The order a session's desktop icons sit in, as last arranged by hand.
 *
 * An arrangement is a preference about this machine's screen, not a fact about the session, so it
 * lives where the shortcuts and the density live: the WebView's own storage, keyed by session id.
 * Two sessions reaching one machine may see different file systems through different accounts, and
 * an arrangement that moved an icon somebody cannot see would be a lie about their desktop.
 *
 * The order is stored as icon ids rather than as positions, and that is the whole point of the
 * shape. A position only means something against the list it was written for: adding one icon — a
 * shortcut somebody just made, or a fixed door a later build introduces — would shift every icon
 * after it, so "the third slot" would silently point at a different icon than the one somebody put
 * there. Ids say which icon sits where, so an icon the order has never heard of is appended at the
 * end and nobody else moves; an id whose icon is gone is simply not found and is dropped.
 */

/** Where one session's arrangement lives. The session id is the rest of the key, as with shortcuts. */
export const WORKBENCH_ICON_ORDER_KEY_PREFIX = "sevenshell-workbench-order:";

/** The storage key for one session's desktop. */
export function iconOrderKey(sessionId: string): string {
  return `${WORKBENCH_ICON_ORDER_KEY_PREFIX}${sessionId}`;
}

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A WebView with storage refused throws on the property itself rather than on a call, and a
    // desktop's arrangement is not worth failing a render over.
    return null;
  }
}

/**
 * What a stored value still says, or null when it says nothing this build can use.
 *
 * Junk is a value a later shape wrote, a hand-edited key, or a half-written string; the default
 * arrangement is a perfectly good answer to all three, and a corrupt arrangement that half applied
 * would be worse than none at all. Entries that are not non-empty strings, and repeats of an id
 * already kept, are refused for the same reason the shortcut list refuses them.
 */
export function parseIconOrder(raw: string | null): string[] | null {
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!Array.isArray(parsed)) {
    return null;
  }

  const order: string[] = [];
  const seen = new Set<string>();
  for (const value of parsed) {
    if (typeof value !== "string" || value === "" || seen.has(value)) {
      continue;
    }
    seen.add(value);
    order.push(value);
  }
  return order;
}

/**
 * The stored arrangement applied to the icons this build actually has.
 *
 * Ids in the arrangement that name no icon on this desktop are dropped — a shortcut was removed, or
 * a build drew a door this one does not. Icons the arrangement never heard of keep the default
 * order and land after it, which is what "a new icon appends at the end" means in practice.
 */
export function normalizeIconOrder(order: readonly string[] | null, ids: readonly string[]): string[] {
  const present = new Set(ids);
  const seen = new Set<string>();
  const next: string[] = [];

  for (const id of order ?? []) {
    if (!present.has(id) || seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  for (const id of ids) {
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    next.push(id);
  }
  return next;
}

/**
 * The arrangement after dragging one icon onto another, or onto nothing for the end.
 *
 * The dragged icon takes the target's slot: with A B C, dragging B onto C answers A C B, not the
 * unchanged list a naive "insert before the target" would produce. Nothing happens when the drag
 * names an icon that is not on the desktop, or when it is dropped onto itself.
 */
export function moveIcon(order: readonly string[], from: string, to: string | null): string[] {
  const dragged = order.indexOf(from);
  if (dragged === -1) {
    return [...order];
  }
  const without = order.filter((id) => id !== from);
  if (to === null) {
    return [...without, from];
  }
  if (to === from) {
    return [...order];
  }
  const target = order.indexOf(to);
  if (target === -1) {
    return [...order];
  }
  return [...without.slice(0, target), from, ...without.slice(target)];
}

/** What is remembered for this session, or null for "nobody has arranged this desktop". */
export function readIconOrder(sessionId: string): string[] | null {
  try {
    return parseIconOrder(storage()?.getItem(iconOrderKey(sessionId)) ?? null);
  } catch {
    return null;
  }
}

/** Writes the arrangement down. A storage that refuses the write costs the next visit its order. */
export function writeIconOrder(sessionId: string, order: readonly string[]): void {
  try {
    storage()?.setItem(iconOrderKey(sessionId), JSON.stringify(order));
  } catch {
    // Full or read-only storage: the arrangement in this run still stands, and the next visit
    // starts from the default.
  }
}

/** Forgets this session's arrangement, which is how the desktop goes back to its default order. */
export function clearIconOrder(sessionId: string): void {
  try {
    storage()?.removeItem(iconOrderKey(sessionId));
  } catch {
    // A storage that refuses the removal leaves the old order to be replaced by the next drag.
  }
}
