/**
 * The Compose page's own readings and refusals, in one place so the spec can question them.
 *
 * The project name rule is the engine's own — the CLI lowercases silently, and a name the engine
 * would rewrite is a name this form refuses instead. The Compose file check is deliberately light:
 * a text area is not an editor, and full YAML grammar is the engine's to judge. What the form
 * refuses here is what no Compose file could survive — tab indentation, and a line that returns to
 * an indentation no open level holds — because those two are the mistakes that make an engine
 * answer with an error nobody can point at.
 */

/** Compose's own project-name grammar, as the engine's validator keeps it. */
const COMPOSE_NAME_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** How long a name the CLI itself would carry. */
const MAX_COMPOSE_NAME_CHARS = 255;

/** Whether a project name is one the engine would use exactly as typed. */
export function isValidComposeName(name: string): boolean {
  return name.length <= MAX_COMPOSE_NAME_CHARS && COMPOSE_NAME_PATTERN.test(name);
}

/** The path a Compose file lives at: absolute, with no doubled or trailing slash to trip the CLI. */
export function isValidYmlDirectory(directory: string): boolean {
  return (
    directory.startsWith("/") && !directory.endsWith("/") && !directory.includes("//") && !directory.includes("\n")
  );
}

/** The yml path a project is written to: the chosen directory's own Compose file. */
export function composeYmlPath(directory: string): string {
  return `${directory}/docker-compose.yml`;
}

/** What went wrong with a Compose file, and where. */
export interface YmlProblem {
  /** The one-based line the reader should look at. */
  line: number;
  kind: "tab" | "indent";
}

/**
 * Reads a Compose file the way a YAML parser walks it — by indentation alone, which is the whole
 * of the grammar a text area can be asked about cheaply. Every content line must sit at an
 * indentation either deeper than the line above it or exactly level with one of the levels its
 * parents opened; anything else is a file the engine would read as a different shape than the one
 * on screen.
 */
export function composeYmlProblem(text: string): YmlProblem | null {
  // The levels the file has opened so far, innermost last. The top level starts at zero.
  const levels: number[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    // Blank lines and comments carry no level of their own.
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    const indent = line.length - line.trimStart().length;
    if (line.slice(0, indent).includes("\t")) {
      return { line: index + 1, kind: "tab" };
    }
    const last = levels.length === 0 ? 0 : (levels[levels.length - 1] ?? 0);
    if (indent > last) {
      // A child of whatever is above it: the level opens here.
      levels.push(indent);
      continue;
    }
    // A sibling or an ancestor: the file returns to a level its parents must have opened.
    while (levels.length > 0 && (levels[levels.length - 1] ?? 0) > indent) {
      levels.pop();
    }
    if ((levels[levels.length - 1] ?? 0) !== indent) {
      return { line: index + 1, kind: "indent" };
    }
  }
  return null;
}

/** The tone a project's status line is drawn in: the words the plugin prints are the trigger. */
export function composeStatusTone(status: string): "success" | "neutral" | "warning" | "danger" {
  const lowered = status.trim().toLowerCase();
  if (lowered === "") {
    return "neutral";
  }
  // The failure words are read before the state words: "exited with error" is a failure, not a
  // clean exit.
  if (lowered.includes("error") || lowered.startsWith("dead")) {
    return "danger";
  }
  if (lowered.startsWith("running") || lowered.startsWith("healthy")) {
    return "success";
  }
  if (lowered.startsWith("exited") || lowered.startsWith("created")) {
    return "neutral";
  }
  return "warning";
}

/** The projects a text filter leaves, by name, in the order the engine gave them. */
export function filterComposeProjects<T extends { name: string }>(projects: readonly T[], text: string): T[] {
  const needle = text.trim().toLowerCase();
  if (needle === "") {
    return [...projects];
  }
  return projects.filter((project) => project.name.toLowerCase().includes(needle));
}

/**
 * How many of the projects are running — the rail's Compose badge carries the count.
 *
 * The word is the plugin's own: a project is running when its status line starts with "running",
 * the same reading the row menu's start verb takes before it offers to bring the file up.
 */
export function composeRunningCount(projects: readonly { status: string }[]): number {
  return projects.filter((project) => project.status.toLowerCase().startsWith("running")).length;
}
