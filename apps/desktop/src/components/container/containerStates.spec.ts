/**
 * The state table, driven by the table itself: one case per state the engine reports, plus the two
 * ways an unknown state has to behave.
 *
 * The point of driving the suite from `CONTAINER_STATES` is that a state added to the table is
 * automatically tested, and a state removed from it breaks the suite loudly — a tone nobody mapped
 * is the exact regression this module exists to prevent.
 */
import { describe, expect, it } from "vitest";

import {
  CONTAINER_LOADING_KEYS,
  CONTAINER_STATES,
  containerStateLabel,
  containerStateStyle,
} from "@/components/container/containerStates";

describe("the nine container states", () => {
  it("names exactly the nine states the desktop window draws", () => {
    expect(CONTAINER_STATES).toEqual([
      "running",
      "exited",
      "created",
      "restarting",
      "paused",
      "dead",
      "updating",
      "starting",
      "stopping",
    ]);
  });

  for (const state of CONTAINER_STATES) {
    it(`draws ${state} on its mapped tone with a label key of its own`, () => {
      const style = containerStateStyle(state);
      expect(style.tone).toMatch(/^(success|danger|warning|neutral)$/);
      expect(style.labelKey).toBe(`container.state.${state}`);
    });
  }

  it("puts running on success and dead on danger", () => {
    expect(containerStateStyle("running").tone).toBe("success");
    expect(containerStateStyle("dead").tone).toBe("danger");
  });

  it("keeps the transitions and paused on warning, exited and created on neutral", () => {
    for (const state of ["starting", "stopping", "restarting", "updating", "paused"]) {
      expect(containerStateStyle(state).tone, state).toBe("warning");
    }
    for (const state of ["exited", "created"]) {
      expect(containerStateStyle(state).tone, state).toBe("neutral");
    }
  });
});

describe("an unknown state", () => {
  it("falls to the neutral tone and never guesses a colour", () => {
    expect(containerStateStyle("some-new-engine-state").tone).toBe("neutral");
    expect(containerStateStyle("some-new-engine-state").labelKey).toBe("");
  });

  it("stays the engine's word, untranslated rather than mistranslated", () => {
    expect(containerStateLabel("some-new-engine-state", () => "SHOULD NOT BE CALLED")).toBe("some-new-engine-state");
  });

  it("names a known state through its key", () => {
    expect(containerStateLabel("running", (key) => `label for ${key}`)).toBe("label for container.state.running");
  });
});

describe("the loading words", () => {
  it("pairs each write action with its own key, en and zh rendered by the caller", () => {
    expect(CONTAINER_LOADING_KEYS).toEqual({
      start: "container.loadingActions.starting",
      stop: "container.loadingActions.stopping",
      restart: "container.loadingActions.restarting",
      rm: "container.loadingActions.removing",
    });
  });
});
