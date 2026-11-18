/**
 * The desktop's app shelf, as metadata.
 *
 * There is no behaviour here to exercise — the shelf is data, and the pane reads it. What the
 * checks hold are the invariants every drawing surface relies on: two applications with distinct
 * kinds, names and hints that are real keys, a plate colour each, and a lookup that answers about
 * the window kinds the shelf carries and about none of the desktop's other windows.
 */
import { describe, expect, it } from "vitest";

import { DESKTOP_APPS, desktopApp, opensWindow } from "@/lib/workbench/desktopApps";

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
});
