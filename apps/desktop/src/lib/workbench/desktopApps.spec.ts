/**
 * The desktop's app shelf, as metadata.
 *
 * There is no behaviour here to exercise — the shelf is data, and the pane reads it. What the
 * checks hold are the invariants every drawing surface relies on: two applications with distinct
 * kinds, names and hints that are real keys, a plate colour each, and a lookup that answers about
 * the window kinds the shelf carries and about none of the desktop's other windows.
 */
import { describe, expect, it } from "vitest";

import {
  DESKTOP_APPS,
  desktopApp,
  opensWindow,
  WORKBENCH_DOORS,
  workbenchIconOf,
  workbenchToneOf,
} from "@/lib/workbench/desktopApps";

describe("the desktop's app shelf", () => {
  it("offers the Docker door and the transfers door, in the order the shelf draws them", () => {
    expect(DESKTOP_APPS.map((app) => app.id)).toEqual(["docker", "transfers"]);
    expect(DESKTOP_APPS.map((app) => app.kind)).toEqual(["docker", "transfers"]);
  });

  it("names every application with label and hint keys, and colours each plate", () => {
    for (const app of DESKTOP_APPS) {
      expect(app.labelKey).toMatch(/^workbench\.desktop\.icons\./);
      expect(app.hintKey).toMatch(/^workbench\.desktop\.apps\./);
      expect(app.tone).toMatch(/^bg-\w+-\d+\/\d+$/);
    }
    expect(desktopApp("docker")?.tone).toBe("bg-sky-600/90");
    expect(desktopApp("transfers")?.tone).toBe("bg-cyan-600/90");
  });

  it("answers about the window kinds the shelf carries, and about the desktop's other windows", () => {
    expect(desktopApp("docker")?.id).toBe("docker");
    expect(desktopApp("transfers")?.id).toBe("transfers");
    expect(desktopApp("terminal")).toBeNull();
    expect(desktopApp("files")).toBeNull();
    expect(desktopApp("monitor")).toBeNull();
    expect(opensWindow("docker")).toBe(true);
    expect(opensWindow("transfers")).toBe(true);
    expect(opensWindow("terminal")).toBe(false);
    expect(opensWindow("trash")).toBe(false);
  });

  it("reads the shelf's glyphs and tones from the door table, so the two cannot drift", () => {
    for (const app of DESKTOP_APPS) {
      const door = WORKBENCH_DOORS.find((entry) => entry.kind === app.kind);
      expect(door, `the door table carries ${app.kind}`).toBeDefined();
      expect(app.icon).toBe(door?.icon);
      expect(app.tone).toBe(door?.tone);
    }
  });
});

describe("the desktop's doors", () => {
  it("carries one door per icon-grid id, with kinds that never repeat", () => {
    const ids = WORKBENCH_DOORS.map((door) => door.id);
    const kinds = WORKBENCH_DOORS.map((door) => door.kind);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(kinds).size).toBe(kinds.length);
    // The grid's order, which the desktop draws from the top left down.
    expect(kinds).toEqual([
      "home",
      "terminal",
      "docker",
      "monitor",
      "systemInfo",
      "system",
      "transfers",
      "forwards",
      "services",
      "tail",
      "batch",
      "trash",
    ]);
  });

  it("draws every plate at the one contract opacity, in the grid, the starter and the taskbar alike", () => {
    for (const door of WORKBENCH_DOORS) {
      expect(door.labelKey).toMatch(/^workbench\.desktop\.icons\./);
      expect(door.tone).toMatch(/^bg-\w+-\d+\/90$/);
    }
  });

  it("tones a window kind as its door is toned, with amber for the file-browser shapes", () => {
    expect(workbenchToneOf("docker")).toBe("bg-sky-600/90");
    expect(workbenchToneOf("forwards")).toBe("bg-indigo-600/90");
    expect(workbenchToneOf("files")).toBe("bg-amber-500/90");
    expect(workbenchToneOf("shortcut")).toBe("bg-amber-500/90");
    // A kind this table has never heard of draws the neutral plate, not an error.
    expect(workbenchToneOf("something-else")).toBe("bg-slate-500/90");
  });

  it("glyphs a window by what it is, and falls back to the globe for an unknown kind", () => {
    expect(workbenchIconOf("terminal")).not.toBeNull();
    expect(workbenchIconOf("files")).not.toBeNull();
    // The monitor's window is one window, however many door names lead to it.
    expect(workbenchIconOf("monitor")).toBe(workbenchIconOf("systemInfo"));
    expect(workbenchIconOf("docker")).toBe(WORKBENCH_DOORS.find((door) => door.kind === "docker")?.icon);
    expect(workbenchIconOf("something-else")).not.toBeNull();
  });
});
