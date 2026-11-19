/**
 * The Compose page's own readings and refusals: the name rule the engine keeps, the directory a
 * file may be written to, and the two mistakes a text area can catch while a Compose file is being
 * typed — tab indentation, and a line that returns to an indentation no open level holds. Full
 * YAML grammar is the engine's; what is pinned here is that nothing a valid file could be is
 * refused, and the mistakes that make an engine answer with an unpointable error do not pass.
 */
import { describe, expect, it } from "vitest";

import {
  composeStatusTone,
  composeYmlPath,
  composeYmlProblem,
  filterComposeProjects,
  isValidComposeName,
  isValidYmlDirectory,
} from "./compose";

describe("project names", () => {
  it("accepts the names the engine would use exactly as typed", () => {
    expect(isValidComposeName("my-web-app")).toBe(true);
    expect(isValidComposeName("2fast")).toBe(true);
    expect(isValidComposeName("web_app")).toBe(true);
  });

  it("refuses what the CLI would rewrite or bounce", () => {
    expect(isValidComposeName("My-Web-App"), "the CLI lowercases silently, so this is refused").toBe(false);
    expect(isValidComposeName("-leading")).toBe(false);
    expect(isValidComposeName("with space")).toBe(false);
    expect(isValidComposeName("")).toBe(false);
    expect(isValidComposeName("a".repeat(256))).toBe(false);
  });
});

describe("the file's directory", () => {
  it("takes an absolute remote path", () => {
    expect(isValidYmlDirectory("/opt/compose/my-app")).toBe(true);
    expect(isValidYmlDirectory("/srv")).toBe(true);
  });

  it("refuses what the engine's path check refuses", () => {
    expect(isValidYmlDirectory("relative/path")).toBe(false);
    expect(isValidYmlDirectory("/opt/compose/")).toBe(false);
    expect(isValidYmlDirectory("/opt//compose")).toBe(false);
    expect(isValidYmlDirectory("")).toBe(false);
    expect(isValidYmlDirectory("/opt\n/escape")).toBe(false);
  });

  it("writes the file to the directory's own Compose file", () => {
    expect(composeYmlPath("/opt/compose/my-app")).toBe("/opt/compose/my-app/docker-compose.yml");
  });
});

describe("the file check", () => {
  it("passes the file a Compose parser would accept", () => {
    const good = [
      "services:",
      "  web:",
      "    image: nginx:latest",
      "    ports:",
      '      - "8080:80"',
      "    environment:",
      "      - KEY=VALUE",
      "",
      "# a comment, and blank lines, carry no level",
      "volumes:",
      "  data:",
    ].join("\n");
    expect(composeYmlProblem(good)).toBeNull();
    expect(composeYmlProblem("")).toBeNull();
    expect(composeYmlProblem("services:\n  web:\n")).toBeNull();
  });

  it("refuses a tab in the indentation, and names the line", () => {
    const problem = composeYmlProblem("services:\n  web:\n\timage: nginx");
    expect(problem).toEqual({ line: 3, kind: "tab" });
  });

  it("refuses a line that returns to an indentation no open level holds", () => {
    const problem = composeYmlProblem("services:\n  web:\n    image: nginx\n ports: []");
    expect(problem).toEqual({ line: 4, kind: "indent" });
  });

  it("lets a sibling and a return to the top level through", () => {
    const sibling = "services:\n  web:\n    image: nginx\n  db:\n    image: redis";
    expect(composeYmlProblem(sibling)).toBeNull();
    const backToTop = "services:\n  web:\n    image: nginx\nvolumes:\n  data:";
    expect(composeYmlProblem(backToTop)).toBeNull();
  });
});

describe("the status tone", () => {
  it("reads the words the plugin prints", () => {
    expect(composeStatusTone("running(2)")).toBe("success");
    expect(composeStatusTone("exited(1)")).toBe("neutral");
    expect(composeStatusTone("created")).toBe("neutral");
    expect(composeStatusTone("exited with error(1)")).toBe("danger");
    expect(composeStatusTone("restarting(3)")).toBe("warning");
    expect(composeStatusTone("")).toBe("neutral");
  });
});

describe("filtering", () => {
  const PROJECTS = [{ name: "web-app" }, { name: "monitoring" }, { name: "mem-compose-test" }];

  it("keeps everything when the filter is empty", () => {
    expect(filterComposeProjects(PROJECTS, "")).toHaveLength(3);
    expect(filterComposeProjects(PROJECTS, "  ")).toHaveLength(3);
  });

  it("keeps the names that carry the text, in the order they came in", () => {
    expect(filterComposeProjects(PROJECTS, "MON").map((project) => project.name)).toEqual(["monitoring"]);
    expect(filterComposeProjects(PROJECTS, "test").map((project) => project.name)).toEqual(["mem-compose-test"]);
  });
});
