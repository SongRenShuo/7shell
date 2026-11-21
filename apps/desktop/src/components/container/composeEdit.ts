/**
 * The line diff the Compose file's editor shows before a save.
 *
 * The preview's one job is to make "what will change" readable while the file is still only text
 * on a dialog: the lines the edited file no longer has, and the ones it gained. It is a line LCS —
 * a Compose file a person edits is a few dozen lines, and the worst case falls back to whole-file
 * removal-and-addition rather than guessing: a preview that invents correspondences is worse than
 * one that says the file changed in full.
 */

/** One line of the preview, and which side of the save it lives on. */
export interface YamlDiffRow {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
  /** The one-based line in the file as it was; absent for a line the save adds. */
  readonly before: number | null;
  /** The one-based line in the file as saved; absent for a line the save removes. */
  readonly after: number | null;
}

/** Above this line count on either side the preview stops matching lines and shows the whole
 * change. The bound keeps a pathological paste from squaring into an unusable render. */
const MAX_DIFF_LINES = 2000;

/** The LCS walk's table: lengths[i * width + j] is the LCS length of before[0..i) and after[0..j). */
function lcsLengths(before: readonly string[], after: readonly string[]): Uint32Array {
  const width = after.length + 1;
  const lengths = new Uint32Array((before.length + 1) * width);
  for (let i = 1; i <= before.length; i += 1) {
    for (let j = 1; j <= after.length; j += 1) {
      lengths[i * width + j] =
        before[i - 1] === after[j - 1]
          ? (lengths[(i - 1) * width + (j - 1)] ?? 0) + 1
          : Math.max(lengths[(i - 1) * width + j] ?? 0, lengths[i * width + (j - 1)] ?? 0);
    }
  }
  return lengths;
}

/** The whole file, stated as removed and added in full — the fallback for an oversized edit. */
function wholesale(before: readonly string[], after: readonly string[]): YamlDiffRow[] {
  return [
    ...before.map((text, index) => ({ kind: "removed" as const, text, before: index + 1, after: null })),
    ...after.map((text, index) => ({ kind: "added" as const, text, before: null, after: index + 1 })),
  ];
}

/** The preview rows: the lines two files share, lined up, with what each side lost or gained. */
export function diffYaml(before: string, after: string): YamlDiffRow[] {
  const beforeLines = before.split("\n");
  const afterLines = after.split("\n");
  if (beforeLines.length > MAX_DIFF_LINES || afterLines.length > MAX_DIFF_LINES) {
    return wholesale(beforeLines, afterLines);
  }
  const width = afterLines.length + 1;
  const lengths = lcsLengths(beforeLines, afterLines);
  // The walk goes from the ends of both files backward through the table: at each mismatched pair
  // it steps the side whose step keeps the longer common prefix — the LCS's own answer — and a tie
  // steps the edited file first, so a changed line reads as the old line removed before the new
  // one added. The rows come out reversed, and are reversed back.
  const walked: YamlDiffRow[] = [];
  let i = beforeLines.length;
  let j = afterLines.length;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && beforeLines[i - 1] === afterLines[j - 1]) {
      walked.push({ kind: "same", text: beforeLines[i - 1] ?? "", before: i, after: j });
      i -= 1;
      j -= 1;
      continue;
    }
    const stepBefore = i > 0 && (j === 0 || (lengths[(i - 1) * width + j] ?? 0) > (lengths[i * width + (j - 1)] ?? 0));
    if (stepBefore) {
      walked.push({ kind: "removed", text: beforeLines[i - 1] ?? "", before: i, after: null });
      i -= 1;
    } else {
      walked.push({ kind: "added", text: afterLines[j - 1] ?? "", before: null, after: j });
      j -= 1;
    }
  }
  return walked.reverse();
}

/** How many lines the save takes away and brings in — the one number the confirm names. */
export function countDiffChanges(rows: readonly YamlDiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "added") {
      added += 1;
    } else if (row.kind === "removed") {
      removed += 1;
    }
  }
  return { added, removed };
}

/** Whether a save has anything to write: the text is compared as it stands, whitespace and all. */
export function yamlUnchanged(before: string, after: string): boolean {
  return before === after;
}
