/**
 * The column rule two Docker lists share: what a preference read back looks like, what the width
 * decides on its own, and what a person's explicit choice overrides.
 *
 * What is checked is what a broken rule would do: hide a column the rows are read by, lose a
 * choice to a malformed store entry, or trim the same column twice on a narrow window.
 */
import { describe, expect, it } from "vitest";

import {
  columnStorageKey,
  isColumnShown,
  loadColumnChoices,
  NARROW_VIEWPORT_PX,
  saveColumnChoices,
  shownColumnCount,
} from "@/components/container/listColumns";

const COLUMNS = [
  { id: "name", primary: true },
  { id: "id", primary: false },
  { id: "created", primary: false },
];

describe("the stored choices", () => {
  it("round-trips through the string the storage keeps", () => {
    const raw = saveColumnChoices({ id: "hidden", created: "shown" });
    expect(loadColumnChoices(raw)).toEqual({ id: "hidden", created: "shown" });
  });

  it("reads nothing out of nothing, and costs nothing for a malformed entry", () => {
    expect(loadColumnChoices(null)).toEqual({});
    expect(loadColumnChoices("not json")).toEqual({});
    expect(loadColumnChoices(JSON.stringify(["id", "created"]))).toEqual({});
    expect(loadColumnChoices(JSON.stringify({ id: "gone", created: 3, name: null }))).toEqual({});
  });

  it("names the storage keys one list apart", () => {
    expect(columnStorageKey("containers")).toBe("container:listColumns.containers");
    expect(columnStorageKey("compose")).toBe("container:listColumns.compose");
  });
});

describe("the visibility rule", () => {
  it("never hides a primary column, whatever the width and whatever the store says", () => {
    const column = COLUMNS[0]!;
    expect(isColumnShown(column, {}, true)).toBe(true);
    expect(isColumnShown(column, { name: "hidden" }, true)).toBe(true);
  });

  it("follows an explicit choice before it follows the width", () => {
    const column = COLUMNS[1]!;
    expect(isColumnShown(column, { id: "hidden" }, false)).toBe(false);
    expect(isColumnShown(column, { id: "shown" }, true)).toBe(true);
  });

  it("lets the width decide for a column nobody chose", () => {
    const column = COLUMNS[1]!;
    expect(isColumnShown(column, {}, false)).toBe(true);
    expect(isColumnShown(column, {}, true)).toBe(false);
  });

  it("counts the columns a table draws, for the empty row's span", () => {
    // 3 columns wide; narrow hides both secondary ones but never the primary.
    expect(shownColumnCount(COLUMNS, {}, false)).toBe(3);
    expect(shownColumnCount(COLUMNS, {}, true)).toBe(1);
    expect(shownColumnCount(COLUMNS, { id: "shown" }, true)).toBe(2);
  });

  it("keeps the width bound where the plan set it", () => {
    expect(NARROW_VIEWPORT_PX).toBe(900);
  });
});
