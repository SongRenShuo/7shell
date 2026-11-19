/**
 * The table vocabulary, which is what every table in the interface wears.
 *
 * These are the rules from the module's own comment, written as assertions: they are the parts a
 * reader would notice going wrong long before a screenshot did — a row that stops answering the
 * pointer, a selected row that the pointer erases, a panel row that grows a rule it was asked not
 * to have. What each *component* does with the vocabulary is checked in that component's own spec.
 */
import { describe, expect, it } from "vitest";

import { TABLE, rowClass } from "@/lib/table";

const HOVER = "hover:bg-[color-mix(in_srgb,var(--workbench-on-picture)_6%,transparent)]";
const PICKED = "bg-[color-mix(in_srgb,var(--workbench-accent)_12%,transparent)]";
const PICKED_HOVER = "hover:bg-[color-mix(in_srgb,var(--workbench-accent)_16%,transparent)]";

describe("the table vocabulary", () => {
  it("marks the row under the pointer on both surfaces, pressed or not", () => {
    for (const surface of ["page", "panel"] as const) {
      expect(rowClass(surface), `${surface}: the band is what says which row is being read`).toContain(HOVER);
      expect(rowClass(surface, { clickable: true })).toContain(HOVER);
    }
  });

  it("keeps a selected row marked under the pointer rather than replaced by it", () => {
    const picked = rowClass("page", { selected: true });

    expect(picked, "the selection is the accent at its light-default strength").toContain(PICKED);
    expect(picked, "the pointer deepens a selected row: two states, two shades").toContain(PICKED_HOVER);
    expect(rowClass("page"), "and a row that is not selected is not drawn as one").not.toContain(PICKED);
  });

  it("gives the pointer and the keyboard to the rows that can be pressed, and neither to the rest", () => {
    const pressable = rowClass("page", { clickable: true });

    expect(pressable).toContain("cursor-pointer");
    expect(pressable, "the keyboard lands on the accent wash too").toContain(
      "focus-visible:bg-[color-mix(in_srgb,var(--workbench-accent)_12%,transparent)]",
    );
    expect(rowClass("page"), "a row that is only read is not offered as a control").not.toContain("cursor-pointer");
  });

  it("stripes only the tables that ask, and the band still answers over the stripe", () => {
    expect(rowClass("page"), "no zebra unless the caller says so").not.toContain("odd:bg-");
    expect(rowClass("page", { striped: true }), "the odd rows take the weaker neutral wash").toContain(
      "odd:bg-[color-mix(in_srgb,var(--workbench-on-picture)_4%,transparent)]",
    );
    expect(rowClass("page", { striped: true }), "the band still answers").toContain(HOVER);
    expect(rowClass("page", { striped: true, selected: true }), "the selection still keeps its accent").toContain(
      PICKED,
    );
  });

  it("rules the pages' rows apart, and leaves the panel's rows to the band alone", () => {
    expect(TABLE.page.row).toContain("border-b");
    expect(TABLE.panel.row, "at 10px a hairline under every reading is more furniture than it is worth").toBe("");
    expect(rowClass("page")).toContain("border-b border-border/50");
    expect(rowClass("panel")).not.toContain("border-b");
  });

  it("pins the pages' headings over the rows and lets the panel's go", () => {
    expect(TABLE.page.head).toContain("sticky");
    expect(TABLE.page.head, "a row scrolled under a translucent strip is read through it").toContain("bg-background");
    expect(TABLE.panel.head).toBe("");
  });

  it("draws the reference's heading furniture: 1px separators and the 4px ends", () => {
    expect(TABLE.page.headCell, "a separator between the headings, painted from the border token").toContain(
      "after:bg-[var(--workbench-glass-border)]",
    );
    expect(TABLE.page.headCell, "the last heading carries no separator").toContain("last:after:hidden");
    expect(TABLE.page.headCell, "the pinned strip's ends take the table's 4px corners").toContain(
      "first:rounded-tl-[4px]",
    );
    expect(TABLE.panel.headCell, "the panel's headings carry none of that furniture").not.toContain("after:");
  });
});
