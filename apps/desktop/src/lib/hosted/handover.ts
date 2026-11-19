/**
 * The handover link the embedded browser host appends to the page URL.
 *
 * When the desktop shell hands a desktop to the system browser, the URL it opens carries
 * `#token=<t>&open=desktop:<id>`: the one credential this tab authenticates with, and the
 * desktop it was asked to put on screen. Both live in the fragment rather than the query, so
 * neither reaches a server's logs; both are read here once and the fragment is then rewritten
 * out of the address bar, so neither sits in a URL a person can copy or a history entry that
 * outlives the page.
 *
 * The token stays in memory only — it is never written to storage or a store that persists —
 * and travels out on the same per-call auth channel the browser transport already uses. A page
 * that reloads loses it and is refused like any other unauthenticated caller; a fresh URL is
 * one "take the URL again" away on the stub card the shell keeps for a hosted desktop.
 */

/** What the fragment carried: the token this tab authenticates with, and the desktop to open. */
export interface HandoverLink {
  readonly token: string | null;
  /** The session id the link asked to open, already decoded, or null when there was none. */
  readonly open: string | null;
}

/** The prefix that names the open target a desktop session, as the shell writes it. */
const DESKTOP_TARGET_PREFIX = "desktop:";

let parsed: HandoverLink | null = null;
let consumed = false;

/**
 * Parses a fragment in the shape the shell writes: `#token=…&open=desktop:<id>`.
 *
 * Split on `&` and the first `=`, then `decodeURIComponent` per value, because that is exactly
 * the matching pair of the writer's percent-encoding. A form-encoding parser would answer the
 * same for the common shapes but would also read a literal `+` in an id as a space — an id the
 * writer let through untouched would come back wrong. The first value for a repeated key wins,
 * which is also what a second `token=` would mean nowhere else.
 */
export function parseHandoverFragment(hash: string): HandoverLink {
  const params = new Map<string, string>();
  const raw = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const pair of raw.split("&")) {
    if (pair === "") {
      continue;
    }
    const split = pair.indexOf("=");
    const key = split === -1 ? pair : pair.slice(0, split);
    const value = split === -1 ? "" : pair.slice(split + 1);
    if (!params.has(key)) {
      params.set(key, key === "open" ? safeDecode(value) : value);
    }
  }
  const open = params.get("open") ?? null;
  return {
    token: params.get("token") ?? null,
    open: open !== null && open.startsWith(DESKTOP_TARGET_PREFIX) ? open.slice(DESKTOP_TARGET_PREFIX.length) : null,
  };
}

/** Decodes one percent-encoded value; a value that is not valid encoding is taken as it is. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * The token this tab authenticates with: the fragment's own, or the standalone launcher's query
 * parameter where the interface runs from that second host. Empty when neither carried one,
 * which is what an unauthenticated page sends and what the host refuses.
 */
export function handoverToken(): string {
  const fragment = ensureParsed();
  if (fragment.token !== null) {
    return fragment.token;
  }
  if (typeof window === "undefined") {
    return "";
  }
  return new URLSearchParams(window.location.search).get("token") ?? "";
}

/**
 * Takes the deep link's open target, once.
 *
 * Called when the application is ready to act on it — the link is consumed even when the
 * library is not up yet, because a link that arrives twice is one link. Reading it also
 * rewrites the URL without the fragment, so the token and the target leave the address bar the
 * moment they have a reader.
 */
export function consumeHandoverLink(): string | null {
  if (consumed) {
    return null;
  }
  consumed = true;
  const fragment = ensureParsed();
  if (typeof window !== "undefined" && window.location.hash !== "") {
    window.history.replaceState(null, "", window.location.pathname + window.location.search);
  }
  return fragment.open;
}

/** Parses the fragment the page was opened with, once, and remembers it for both readers. */
function ensureParsed(): HandoverLink {
  if (parsed === null) {
    parsed = typeof window === "undefined" ? { token: null, open: null } : parseHandoverFragment(window.location.hash);
  }
  return parsed;
}

/** Forgets what was parsed and consumed. Test-only: a page parses its own URL exactly once. */
export function resetHandoverForTest(hash: string | null): void {
  parsed = null;
  consumed = false;
  if (typeof window !== "undefined" && hash !== null) {
    window.history.replaceState(null, "", `${window.location.pathname}${hash}`);
  }
}
