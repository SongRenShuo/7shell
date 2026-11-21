/**
 * The template store's rules: what a save keeps, what an overwrite replaces, what the cap drops,
 * and what a store holding something unreadable reads as.
 *
 * The wizard's wiring — the shelf, the buttons — is the component's; here are the rules themselves.
 */
import { beforeEach, describe, expect, it } from "vitest";

import {
  CONTAINER_TEMPLATE_LIMIT,
  deleteContainerTemplate,
  loadContainerTemplates,
  saveContainerTemplate,
  type ContainerTemplateValues,
} from "@/components/container/containerTemplates";

const KEY = "container:createTemplates";

function values(image: string): ContainerTemplateValues {
  return {
    name: "",
    image,
    autostart: false,
    startNow: false,
    privileged: false,
    command: "",
    ports: [{ hostPort: "8080", containerPort: "80", protocol: "tcp" }],
    volumes: [],
    env: [{ key: "LOG", value: "info" }],
    labels: [],
    networks: ["bridge"],
    capabilities: [],
    cpuWeight: "mid",
    memoryLimitMb: null,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("the template store", () => {
  it("starts empty", () => {
    expect(loadContainerTemplates()).toEqual([]);
  });

  it("saves a named set and reads it back whole", () => {
    saveContainerTemplate("web", values("nginx:1.27"));

    const list = loadContainerTemplates();
    expect(list).toHaveLength(1);
    const saved = list[0];
    expect(saved?.name).toBe("web");
    expect(saved?.values.image).toBe("nginx:1.27");
    expect(saved?.values.ports).toEqual([{ hostPort: "8080", containerPort: "80", protocol: "tcp" }]);
    expect(saved?.values.env).toEqual([{ key: "LOG", value: "info" }]);
  });

  it("answers nothing for a blank name", () => {
    saveContainerTemplate("   ", values("nginx:1.27"));

    expect(loadContainerTemplates()).toEqual([]);
  });

  it("overwrites in place when the name is saved again, newest first", () => {
    saveContainerTemplate("web", values("nginx:1.27"));
    saveContainerTemplate("cache", values("redis:7"));
    saveContainerTemplate("web", values("nginx:1.29"));

    const list = loadContainerTemplates();
    expect(list).toHaveLength(2);
    expect(list[0]?.name).toBe("web");
    expect(list[0]?.values.image).toBe("nginx:1.29");
    expect(list[1]?.name).toBe("cache");
  });

  it("lets the oldest save fall off past the limit", () => {
    for (let index = 0; index < CONTAINER_TEMPLATE_LIMIT + 4; index += 1) {
      saveContainerTemplate(`template-${index}`, values(`image-${index}`));
    }

    const list = loadContainerTemplates();
    expect(list).toHaveLength(CONTAINER_TEMPLATE_LIMIT);
    expect(list[0]?.name).toBe(`template-${CONTAINER_TEMPLATE_LIMIT + 3}`);
    expect(list.some((template) => template.name === "template-0")).toBe(false);
  });

  it("forgets one template by name and keeps the rest", () => {
    saveContainerTemplate("web", values("nginx:1.27"));
    saveContainerTemplate("cache", values("redis:7"));

    const list = deleteContainerTemplate("web");
    expect(list.map((template) => template.name)).toEqual(["cache"]);
    expect(loadContainerTemplates().map((template) => template.name)).toEqual(["cache"]);
  });

  it("reads a store holding junk as empty rather than throwing", () => {
    window.localStorage.setItem(KEY, "not json at all");
    expect(loadContainerTemplates()).toEqual([]);
  });

  it("reads a store holding the wrong shape as empty", () => {
    window.localStorage.setItem(KEY, JSON.stringify({ name: "web" }));
    expect(loadContainerTemplates()).toEqual([]);
  });

  it("drops only the entries a damaged entry costs alone", () => {
    const good = { name: "web", savedAt: "2026-11-21", values: { image: "nginx:1.27", memoryLimitMb: null } };
    window.localStorage.setItem(KEY, JSON.stringify([good, 42, { name: "", values: {} }, null]));

    const list = loadContainerTemplates();
    expect(list).toHaveLength(1);
    const web = list[0];
    expect(web?.name).toBe("web");
    // The fields a damaged entry never carried read as the form's own defaults, not as undefined.
    expect(web?.values.cpuWeight).toBe("mid");
    expect(web?.values.startNow).toBe(true);
    expect(web?.values.ports).toEqual([]);
    expect(web?.values.networks).toEqual([]);
  });

  it("keeps the first half of a damaged save: a broken row costs itself alone", () => {
    saveContainerTemplate("web", values("nginx:1.27"));
    window.localStorage.setItem(
      KEY,
      JSON.stringify([
        { name: "broken", savedAt: "", values: { image: "x", ports: ["not a row"], env: null } },
        ...loadContainerTemplates(),
      ]),
    );

    const list = loadContainerTemplates();
    expect(list).toHaveLength(2);
    const broken = list.find((template) => template.name === "broken");
    expect(broken?.values.ports).toEqual([]);
    expect(broken?.values.env).toEqual([]);
    expect(broken?.values.image).toBe("x");
  });
});
