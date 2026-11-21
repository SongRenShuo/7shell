/**
 * The line diff the Compose file's editor previews: what it matches, what it refuses to invent,
 * and the two numbers the rebuild confirm names.
 *
 * What is checked is what a wrong diff would do to a person about to save: hide a line the save
 * deletes, pair a changed line as two, or square a pasted file into an unusable render.
 */
import { describe, expect, it } from "vitest";

import { countDiffChanges, diffYaml, yamlUnchanged } from "@/components/container/composeEdit";

const kinds = (rows: ReturnType<typeof diffYaml>) => rows.map((row) => row.kind);

describe("diffYaml", () => {
  it("keeps the shared lines and says nothing changed when nothing did", () => {
    const text = "services:\n  web:\n    image: nginx:latest\n";
    const rows = diffYaml(text, text);
    expect(kinds(rows)).toEqual(["same", "same", "same", "same"]);
    expect(countDiffChanges(rows)).toEqual({ added: 0, removed: 0 });
    expect(rows[0]).toMatchObject({ kind: "same", text: "services:", before: 1, after: 1 });
    expect(yamlUnchanged(text, text)).toBe(true);
  });

  it("pairs the lines around one edit and names the edit a removal and an addition", () => {
    const before = 'services:\n  web:\n    image: nginx:1.25\n    ports:\n      - "8080:80"\n';
    const after = 'services:\n  web:\n    image: nginx:1.27\n    ports:\n      - "8080:80"\n';
    const rows = diffYaml(before, after);
    expect(kinds(rows)).toEqual(["same", "same", "removed", "added", "same", "same", "same"]);
    expect(rows[2]).toMatchObject({ text: "    image: nginx:1.25", before: 3, after: null });
    expect(rows[3]).toMatchObject({ text: "    image: nginx:1.27", before: null, after: 3 });
    expect(countDiffChanges(rows)).toEqual({ added: 1, removed: 1 });
  });

  it("sees an appended block as additions only", () => {
    const before = "services:\n  web:\n    image: nginx\n";
    const after = "services:\n  web:\n    image: nginx\n    restart: unless-stopped\n    tty: true\n";
    const rows = diffYaml(before, after);
    expect(kinds(rows)).toEqual(["same", "same", "same", "added", "added", "same"]);
    expect(rows[3]).toMatchObject({ text: "    restart: unless-stopped", after: 4 });
    expect(countDiffChanges(rows)).toEqual({ added: 2, removed: 0 });
  });

  it("sees a deleted block as removals only", () => {
    const before = "services:\n  web:\n    image: nginx\n    restart: unless-stopped\n    tty: true\n";
    const after = "services:\n  web:\n    image: nginx\n";
    const rows = diffYaml(before, after);
    expect(kinds(rows)).toEqual(["same", "same", "same", "removed", "removed", "same"]);
    expect(countDiffChanges(rows)).toEqual({ added: 0, removed: 2 });
  });

  it("lines a moved block up as a removal and an addition, not a rewrite of the file", () => {
    const before = "services:\n  web:\n    image: nginx\n  db:\n    image: postgres\n";
    const after = "services:\n  db:\n    image: postgres\n  web:\n    image: nginx\n";
    const rows = diffYaml(before, after);
    const changes = countDiffChanges(rows);
    // The two service blocks trade places; the LCS can keep one of them whole, so the change is
    // a handful of lines either way — never a six-line rewrite of a file with six lines.
    expect(changes.added).toBe(changes.removed);
    expect(changes.added).toBeGreaterThanOrEqual(2);
    expect(changes.added).toBeLessThanOrEqual(3);
    expect(rows.some((row) => row.kind === "same" && row.text.includes("image:"))).toBe(true);
  });

  it("reads the whole change for an oversized pair instead of squaring it", () => {
    const before = Array.from({ length: 2001 }, (_, index) => `line ${index}`).join("\n");
    const after = "one line\n";
    const rows = diffYaml(before, after);
    // 2001 lines removed in full, the edited file's two lines added whole.
    expect(rows).toHaveLength(2003);
    expect(rows[0]).toMatchObject({ kind: "removed", before: 1, after: null });
    expect(rows.at(-1)).toMatchObject({ kind: "added", before: null, after: 2 });
  });

  it("handles files that are empty on one side", () => {
    // One empty line against a file of two: the empty line is the trailing line the new file
    // still has, and the only change is the one line the save brings in.
    expect(kinds(diffYaml("", "services:\n"))).toEqual(["added", "same"]);
    expect(countDiffChanges(diffYaml("", "services:\n"))).toEqual({ added: 1, removed: 0 });
    expect(kinds(diffYaml("services:\n", ""))).toEqual(["removed", "same"]);
    expect(countDiffChanges(diffYaml("services:\n", ""))).toEqual({ added: 0, removed: 1 });
  });
});

describe("yamlUnchanged", () => {
  it("compares the text as it stands, whitespace and all", () => {
    expect(yamlUnchanged("a: 1\n", "a: 1\n")).toBe(true);
    expect(yamlUnchanged("a: 1\n", "a: 1")).toBe(false);
    expect(yamlUnchanged("a: 1\n", "a: 2\n")).toBe(false);
  });
});
