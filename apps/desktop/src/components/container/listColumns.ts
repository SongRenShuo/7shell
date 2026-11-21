/**
 * The columns a Docker list draws, and who decides which ones it keeps.
 *
 * Two lists share this vocabulary: the containers' table and the Compose projects' table. The
 * question both answer is the reference manager's: which columns are on screen, remembered across
 * sessions, and trimmed when the window is narrow. The rules are the plan's (D6/D8):
 *
 * - **Primary columns — the ones the rows are read by — cannot be hidden.** A list with no names,
 *   no states and no actions is not a list anymore; the name, the state and the actions are the
 *   floor. The containers' list keeps the image on that floor too, because "which of these runs
 *   what" is the question the table exists for.
 * - **A secondary column's visibility is a preference with a home in localStorage** — it is UI
 *   state with no account system behind it, so it lives beside the workspace's other saved
 *   preferences. Only a choice the person made is written; the columns left untouched follow the
 *   width.
 * - **Under 900px of window the untouched secondary columns are trimmed.** The table keeps its
 *   semantics — no card rearrangement, no media-query magic; the horizontal scroll stays as the
 *   floor — and the trimming only reduces how much of it a narrow window needs. A column the
 *   person has explicitly shown stays shown, narrow or not.
 */

import { computed, onBeforeUnmount, onMounted, ref, type Ref } from "vue";

/** The window width below which a list trims the secondary columns nobody chose. */
export const NARROW_VIEWPORT_PX = 900;

/** The preference key one list's choices live under — the workspace preference family's naming. */
export function columnStorageKey(list: "containers" | "compose"): string {
  return `container:listColumns.${list}`;
}

/** What a secondary column's visibility is: chosen shown, chosen hidden, or left to the width. */
export type ColumnChoice = "shown" | "hidden";

/** The choices one list carries, by column id. Absent means "not chosen" — the width decides. */
export type ColumnChoices = Record<string, ColumnChoice>;

/** Reads one list's choices back. Anything that is not a choice costs nothing. */
export function loadColumnChoices(raw: string | null): ColumnChoices {
  if (raw === null) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    const choices: ColumnChoices = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === "shown" || value === "hidden") {
        choices[key] = value;
      }
    }
    return choices;
  } catch {
    return {};
  }
}

/** Writes one list's choices. A storage that refuses the write costs the memory, not the page. */
export function saveColumnChoices(choices: ColumnChoices): string | null {
  try {
    return JSON.stringify(choices);
  } catch {
    return null;
  }
}

/** Whether this window keeps preferences at all; the render may run where no storage exists. */
function canStore(): boolean {
  return typeof window !== "undefined" && "localStorage" in window;
}

/** Reads one list's choices from the window's storage. */
export function readColumnChoices(list: "containers" | "compose"): ColumnChoices {
  if (!canStore()) {
    return {};
  }
  try {
    return loadColumnChoices(window.localStorage.getItem(columnStorageKey(list)));
  } catch {
    return {};
  }
}

/** Writes one list's choices to the window's storage. */
export function writeColumnChoices(list: "containers" | "compose", choices: ColumnChoices): void {
  if (!canStore()) {
    return;
  }
  try {
    const raw = saveColumnChoices(choices);
    if (raw !== null) {
      window.localStorage.setItem(columnStorageKey(list), raw);
    }
  } catch {
    // The memory is a courtesy: the list itself does not depend on it.
  }
}

/**
 * Whether one column is drawn: a primary column always is, a chosen secondary column follows its
 * choice, and an untouched one follows the width — hidden while narrow, drawn otherwise.
 */
export function isColumnShown(
  column: { readonly id: string; readonly primary: boolean },
  choices: ColumnChoices,
  narrow: boolean,
): boolean {
  if (column.primary) {
    return true;
  }
  const choice = choices[column.id];
  if (choice === "hidden") {
    return false;
  }
  if (choice === "shown") {
    return true;
  }
  return !narrow;
}

/** How many columns a table draws — the empty row's colspan is the table's own count. */
export function shownColumnCount(
  columns: readonly { readonly id: string; readonly primary: boolean }[],
  choices: ColumnChoices,
  narrow: boolean,
): number {
  return columns.filter((column) => isColumnShown(column, choices, narrow)).length;
}

/**
 * The window width, measured and then watched rather than assumed: the window, a split's divider
 * and the desktop's own resize all change it without touching this code.
 */
export function useNarrowViewport(): Ref<boolean> {
  const narrow = ref(false);

  function measure(): void {
    narrow.value = typeof window !== "undefined" && window.innerWidth < NARROW_VIEWPORT_PX;
  }

  onMounted(() => {
    measure();
    window.addEventListener("resize", measure, { passive: true });
  });
  onBeforeUnmount(() => {
    window.removeEventListener("resize", measure);
  });

  return computed(() => narrow.value);
}
