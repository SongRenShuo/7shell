/**
 * The merged log view's shared readings: what a source's prefix wears, what a Compose line's
 * service is called, and what a downloaded buffer names itself.
 *
 * A line from more than one container has to say where it came from, or the merge is noise; the
 * colour it says it with comes from the theme's tokens — this module owns only which token means
 * "first source", never what the colour looks like.
 */

/** One log entry as the views hold it: the raw line, and the container it came from. */
export interface LogEntry {
  readonly line: string;
  /** The container's name, when the line came from a merged stream; `null` is a lone stream. */
  readonly source: string | null;
}

/**
 * The tokens the log prefixes wear, in the order sources are picked.
 *
 * Every value is a `var(--…)` reference — the theme layer owns what the colours look like, and
 * this list owns only what each position means.
 */
export const LOG_SOURCE_COLORS: readonly string[] = [
  "var(--log-source-1)",
  "var(--log-source-2)",
  "var(--log-source-3)",
  "var(--log-source-4)",
];

/** The colour a source picked at `index` wears; more sources than colours cycle the list. */
export function logSourceColor(index: number): string {
  const at = ((index % LOG_SOURCE_COLORS.length) + LOG_SOURCE_COLORS.length) % LOG_SOURCE_COLORS.length;
  return LOG_SOURCE_COLORS[at] ?? "var(--log-source-1)";
}

/**
 * Splits a Compose line's `name | message` prefix from the message that follows.
 *
 * `docker compose logs` prefixes every line with the writing container's name, one space, a pipe,
 * one space. A line without that shape — a blank, a wrapped continuation — has no prefix to split,
 * and `null` says so rather than inventing one.
 */
export function splitComposePrefix(line: string): { prefix: string; message: string } | null {
  const at = line.indexOf(" | ");
  if (at <= 0) {
    return null;
  }
  const prefix = line.slice(0, at);
  // A container name carries no whitespace; anything wider is a message that merely contains a pipe.
  if (/[\s]/.test(prefix)) {
    return null;
  }
  return { prefix, message: line.slice(at + 3) };
}

/**
 * The service a Compose line belongs to, read out of its prefix.
 *
 * Compose names its containers `project-service-index`, so the service is what the prefix keeps
 * once the project and the trailing index are gone; a runtime that prefixes with the service name
 * alone is already there. A line with no prefix belongs to no service and comes back as `""`.
 */
export function composeLogService(line: string, project: string): string {
  const split = splitComposePrefix(line);
  if (split === null) {
    return "";
  }
  let service = split.prefix;
  const indexed = /^(.*?)-\d+$/.exec(service);
  if (indexed?.[1] !== undefined && indexed[1] !== "") {
    service = indexed[1];
  }
  if (project !== "" && service.startsWith(`${project}-`)) {
    service = service.slice(project.length + 1);
  }
  return service;
}

/**
 * The file name a downloaded buffer carries: the containers it came from, and the day.
 *
 * The date is the download's own (`YYYYMMDD`, local — the person reading the name knows their own
 * time zone), and names are narrowed to what a file system accepts, because a container named
 * with a slash must not become a directory the download writes into.
 */
export function logFileName(names: readonly string[], now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const safe = names
    .map((name) => name.replace(/[^\w.-]+/g, "_"))
    .filter((name) => name !== "")
    .slice(0, 4);
  const base = (safe.length > 0 ? safe.join("-") : "logs").slice(0, 120);
  return `${base}-${stamp}.log`;
}
