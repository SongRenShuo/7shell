/**
 * The tag grammar, said once so the pull dialog and its hint cannot drift apart.
 *
 * The table drives the cases: a tag that starts with a separator, one that carries a character
 * Docker refuses, one that outgrows the 128-character rule, and the empty tag that means "the
 * default" and is therefore legal.
 */
import { describe, expect, it } from "vitest";

import { imageReference, isValidImageName, isValidImageTag } from "@/components/container/imageTags";

describe("the image tag grammar", () => {
  it("accepts the tags Docker does", () => {
    for (const tag of ["latest", "1.19.4", "alpine_3.19", "v2-beta", "0"]) {
      expect(isValidImageTag(tag), tag).toBe(true);
    }
  });

  it("refuses a tag that starts with a separator", () => {
    expect(isValidImageTag(".hidden")).toBe(false);
    expect(isValidImageTag("-v")).toBe(false);
    expect(isValidImageTag("_x")).toBe(false);
  });

  it("refuses a tag carrying a character Docker does not name", () => {
    expect(isValidImageTag("release/1")).toBe(false);
    expect(isValidImageTag("has space")).toBe(false);
    expect(isValidImageTag("colon:tag")).toBe(false);
  });

  it("refuses a tag longer than Docker's 128 characters", () => {
    expect(isValidImageTag("a".repeat(128))).toBe(true);
    expect(isValidImageTag("a".repeat(129))).toBe(false);
  });

  it("treats the empty tag as the default and lets it through", () => {
    expect(isValidImageTag("")).toBe(true);
  });
});

describe("the pull's two fields", () => {
  it("needs a repository name before anything can be pulled", () => {
    expect(isValidImageName("nginx")).toBe(true);
    expect(isValidImageName("registry.example.com:5000/team/app")).toBe(true);
    expect(isValidImageName("   ")).toBe(false);
  });

  it("joins the reference the way the engine reads it: no tag, no colon", () => {
    expect(imageReference(" nginx ", "1.27 ")).toBe("nginx:1.27");
    expect(imageReference("nginx", "")).toBe("nginx");
  });
});
