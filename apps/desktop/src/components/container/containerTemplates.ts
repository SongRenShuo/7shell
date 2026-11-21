/**
 * The create wizard's named templates, kept for reuse.
 *
 * A set of wizard answers worth typing once is worth keeping: the person names the set, the wizard
 * fills it back in on the next create, and the list is this device's own — the same family of
 * local memory the batch panel's history and the panels' layout live in. Nothing here is a secret
 * by design, and that is exactly why the plain-text store is said plainly on the save row: a
 * template that would carry a credential should not be saved at all.
 *
 * The values are what the wizard's form holds — the same fields a clone ask pre-fills, in the
 * same shape — so applying one walks the same mapping a clone walks. A full or refusing store
 * costs the memory, never the wizard.
 */

/** How many templates the store keeps: enough to cover a working set, few enough to scan. */
export const CONTAINER_TEMPLATE_LIMIT = 30;

const TEMPLATES_KEY = "container:createTemplates";

/**
 * What one template keeps of the wizard's answers. The same fields the clone prefill
 * (`ContainerClonePrefill` in the wizard) carries — the two share the apply mapping, so a template
 * fills the form exactly the way a copy does.
 */
export interface ContainerTemplateValues {
  readonly name: string;
  readonly image: string;
  readonly autostart: boolean;
  readonly startNow: boolean;
  readonly privileged: boolean;
  readonly command: string;
  readonly ports: readonly { hostPort: string; containerPort: string; protocol: "tcp" | "udp" }[];
  readonly volumes: readonly { hostPath: string; containerPath: string; readOnly: boolean }[];
  readonly env: readonly { key: string; value: string }[];
  readonly labels: readonly { name: string; value: string }[];
  readonly networks: readonly string[];
  readonly capabilities: readonly string[];
  readonly cpuWeight: "low" | "mid" | "high";
  /** The memory limit in megabytes, or null when the form had none. */
  readonly memoryLimitMb: string | null;
}

/** One named set of answers, with the day it was last saved. */
export interface ContainerTemplate {
  readonly name: string;
  readonly savedAt: string;
  readonly values: ContainerTemplateValues;
}

/**
 * Reads one value back the way the wizard would apply it, defaulting what is missing rather than
 * carrying `undefined` into a field. A row that is not an object is dropped; a field that is not
 * the shape it was saved as falls to the form's own default — a damaged entry costs itself alone.
 */
function sanitizeValues(raw: unknown): ContainerTemplateValues | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const value = raw as Record<string, unknown>;
  const rows = (key: string): Record<string, unknown>[] =>
    Array.isArray(value[key])
      ? (value[key] as unknown[]).filter(
          (row): row is Record<string, unknown> => row !== null && typeof row === "object" && !Array.isArray(row),
        )
      : [];
  const strings = (key: string): string[] =>
    Array.isArray(value[key])
      ? (value[key] as unknown[]).filter((row): row is string => typeof row === "string" && row !== "")
      : [];
  const text = (key: string): string => (typeof value[key] === "string" ? (value[key] as string) : "");
  const flag = (key: string): boolean => value[key] === true;
  const cpu = value["cpuWeight"];
  const cpuWeight: ContainerTemplateValues["cpuWeight"] = cpu === "low" || cpu === "high" ? cpu : "mid";
  const memory = value["memoryLimitMb"];
  return {
    name: text("name"),
    image: text("image"),
    autostart: flag("autostart"),
    startNow: value["startNow"] === undefined ? true : flag("startNow"),
    privileged: flag("privileged"),
    command: text("command"),
    ports: rows("ports").map((row) => ({
      hostPort: typeof row["hostPort"] === "string" ? row["hostPort"] : "",
      containerPort: typeof row["containerPort"] === "string" ? row["containerPort"] : "",
      protocol: row["protocol"] === "udp" ? ("udp" as const) : ("tcp" as const),
    })),
    volumes: rows("volumes").map((row) => ({
      hostPath: typeof row["hostPath"] === "string" ? row["hostPath"] : "",
      containerPath: typeof row["containerPath"] === "string" ? row["containerPath"] : "",
      readOnly: row["readOnly"] === true,
    })),
    env: rows("env").map((row) => ({
      key: typeof row["key"] === "string" ? row["key"] : "",
      value: typeof row["value"] === "string" ? row["value"] : "",
    })),
    labels: rows("labels").map((row) => ({
      name: typeof row["name"] === "string" ? row["name"] : "",
      value: typeof row["value"] === "string" ? row["value"] : "",
    })),
    networks: strings("networks"),
    capabilities: strings("capabilities"),
    cpuWeight,
    memoryLimitMb: typeof memory === "string" ? memory : null,
  };
}

/** Reads the store back, newest save first. Anything that is not a template costs nothing. */
export function loadContainerTemplates(): ContainerTemplate[] {
  if (typeof window === "undefined" || !("localStorage" in window)) {
    return [];
  }
  try {
    const raw = window.localStorage.getItem(TEMPLATES_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const templates: ContainerTemplate[] = [];
    for (const entry of parsed) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        continue;
      }
      const name = (entry as Record<string, unknown>)["name"];
      if (typeof name !== "string" || name.trim() === "") {
        continue;
      }
      const values = sanitizeValues((entry as Record<string, unknown>)["values"]);
      if (values === null) {
        continue;
      }
      const savedAt = (entry as Record<string, unknown>)["savedAt"];
      templates.push({
        name,
        savedAt: typeof savedAt === "string" ? savedAt : "",
        values,
      });
    }
    return templates;
  } catch {
    return [];
  }
}

function persist(templates: ContainerTemplate[]): void {
  if (typeof window !== "undefined" && "localStorage" in window) {
    try {
      window.localStorage.setItem(TEMPLATES_KEY, JSON.stringify(templates));
    } catch {
      // The memory is a courtesy: the wizard itself does not depend on it.
    }
  }
}

/**
 * Saves the answers under a name: a name already in the store is overwritten in place — a template
 * is its name — and the list stays capped, the oldest save falling off first. Returns the list as
 * it now stands. An empty name saves nothing: a template nobody can ask for is not a template.
 */
export function saveContainerTemplate(name: string, values: ContainerTemplateValues): ContainerTemplate[] {
  const trimmed = name.trim();
  if (trimmed === "") {
    return loadContainerTemplates();
  }
  const rest = loadContainerTemplates().filter((template) => template.name !== trimmed);
  const saved: ContainerTemplate = {
    name: trimmed,
    savedAt: new Date().toISOString(),
    values,
  };
  const next = [saved, ...rest].slice(0, CONTAINER_TEMPLATE_LIMIT);
  persist(next);
  return next;
}

/** Forgets one template by name, and answers the list as it now stands. */
export function deleteContainerTemplate(name: string): ContainerTemplate[] {
  const next = loadContainerTemplates().filter((template) => template.name !== name);
  persist(next);
  return next;
}
