/**
 * The merged view's shared readings, as the views use them: a prefix colour per source, the
 * service behind a Compose line's container-name prefix, and the name a downloaded buffer asks for.
 */
import { describe, expect, it } from "vitest";

import {
  composeLogService,
  LOG_SOURCE_COLORS,
  logFileName,
  logSourceColor,
  splitComposePrefix,
} from "@/components/container/logSource";

describe("logSourceColor", () => {
  it("gives each position a colour the theme owns, and cycles when sources outrun them", () => {
    expect(LOG_SOURCE_COLORS).toHaveLength(4);
    expect(logSourceColor(0)).toBe(LOG_SOURCE_COLORS[0]);
    expect(logSourceColor(3)).toBe(LOG_SOURCE_COLORS[3]);
    expect(logSourceColor(4)).toBe(LOG_SOURCE_COLORS[0]);
    expect(logSourceColor(6)).toBe(LOG_SOURCE_COLORS[2]);
  });

  it("keeps the colours apart, because colour is the only thing telling prefixes apart", () => {
    expect(new Set(LOG_SOURCE_COLORS).size).toBe(LOG_SOURCE_COLORS.length);
  });
});

describe("splitComposePrefix", () => {
  it("splits the container name from the message a Compose line carries", () => {
    expect(splitComposePrefix("web-app-web-1 | listening on 80")).toEqual({
      prefix: "web-app-web-1",
      message: "listening on 80",
    });
  });

  it("says so for a line that carries no prefix, rather than inventing one", () => {
    expect(splitComposePrefix("")).toBeNull();
    expect(splitComposePrefix("no pipe in this line")).toBeNull();
    expect(splitComposePrefix("a message that says x | y later")).toBeNull();
  });
});

describe("composeLogService", () => {
  it("reads the service out of a project-service-index container name", () => {
    expect(composeLogService("web-app-web-1 | listening on 80", "web-app")).toBe("web");
    expect(composeLogService("web-app-db-1 | ready", "web-app")).toBe("db");
  });

  it("keeps a service whose own name ends in digits", () => {
    expect(composeLogService("web-app-redis6-1 | ready", "web-app")).toBe("redis6");
  });

  it("takes a bare service name when the runtime prefixes with one", () => {
    expect(composeLogService("worker | job done", "web-app")).toBe("worker");
  });

  it("says no service for a line with no prefix", () => {
    expect(composeLogService("a bare line", "web-app")).toBe("");
  });
});

describe("logFileName", () => {
  const noon = new Date(2026, 10, 21, 12, 0, 0);

  it("names the container and the day the download happened", () => {
    expect(logFileName(["web"], noon)).toBe("web-20261121.log");
    expect(logFileName(["web", "db"], noon)).toBe("web-db-20261121.log");
  });

  it("narrows a name to what a file system accepts", () => {
    expect(logFileName(["weird/name here"], noon)).toBe("weird_name_here-20261121.log");
  });

  it("still names a download when the buffers came from nowhere", () => {
    expect(logFileName([], noon)).toBe("logs-20261121.log");
  });
});
