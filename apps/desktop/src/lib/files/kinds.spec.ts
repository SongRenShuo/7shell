/**
 * The coarse buckets a row's name falls into for the quick filter.
 *
 * A directory is its own bucket whatever it is called; everything else follows its extension, a
 * symlink included — the rules worth pinning are the edges: a name with no extension, a name that
 * is all extension, and the extensions that decide between the buckets.
 */
import { describe, expect, it } from "vitest";

import { kindOf } from "@/lib/files/kinds";

function entry(name: string, kind: "directory" | "file" | "symlink" | "other" = "file") {
  return { kind, name };
}

describe("the kind buckets", () => {
  it("calls every directory a folder, whatever its name says", () => {
    expect(kindOf(entry("photos", "directory"))).toBe("folder");
    expect(kindOf(entry("notes.txt", "directory"))).toBe("folder");
  });

  it("sorts pictures by their extension, symlink or not", () => {
    expect(kindOf(entry("cover.png"))).toBe("image");
    expect(kindOf(entry("photo.JPG"))).toBe("image");
    expect(kindOf(entry("icon.svg", "symlink"))).toBe("image");
  });

  it("sorts archives, including the two-part tar.gz", () => {
    expect(kindOf(entry("bundle.zip"))).toBe("archive");
    expect(kindOf(entry("site.tar.gz"))).toBe("archive");
    expect(kindOf(entry("dump.tgz"))).toBe("archive");
  });

  it("sorts documents and source files together as documents", () => {
    expect(kindOf(entry("readme.md"))).toBe("document");
    expect(kindOf(entry("app.ts"))).toBe("document");
    expect(kindOf(entry("nginx.conf"))).toBe("document");
    expect(kindOf(entry("syslog.log"))).toBe("document");
  });

  it("leaves names without an extension, and unknown ones, as other", () => {
    expect(kindOf(entry("Dockerfile"))).toBe("other");
    expect(kindOf(entry("data.bin"))).toBe("other");
    expect(kindOf(entry("binary", "symlink"))).toBe("other");
  });

  it("does not mistake a leading dot for an extension", () => {
    expect(kindOf(entry(".bashrc"))).toBe("other");
    expect(kindOf(entry("archive."))).toBe("other");
  });
});
