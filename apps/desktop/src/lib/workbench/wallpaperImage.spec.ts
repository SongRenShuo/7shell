/**
 * The wallpaper string's own rules: what each form decodes to, what junk decodes to nothing, and
 * how a colour and an opacity become the string the vault carries.
 *
 * The picture encoder itself is canvas work a DOM-less test cannot witness; what can be pinned
 * here is the part every save and every draw walks through — the parse and the encode.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeColor, encodeImage, parseBackdrop, readStoredImage, writeStoredImage } from "./wallpaperImage";

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
});

describe("parseBackdrop", () => {
  it("reads the four gradient ids", () => {
    expect(parseBackdrop("aurora")).toEqual({ kind: "gradient", id: "aurora" });
    expect(parseBackdrop("plain")).toEqual({ kind: "gradient", id: "plain" });
  });

  it("answers nothing for the interface's default and for junk", () => {
    expect(parseBackdrop(null)).toBeUndefined();
    expect(parseBackdrop(undefined)).toBeUndefined();
    expect(parseBackdrop("printer")).toBeUndefined();
    expect(parseBackdrop("color:#xyz")).toBeUndefined();
    expect(parseBackdrop("color:112233")).toBeUndefined();
    expect(parseBackdrop("img:stretch")).toBeUndefined();
  });

  it("decodes the colour form into css, alpha and all", () => {
    expect(parseBackdrop("color:1e293bd9")).toEqual({ kind: "color", css: "rgba(30, 41, 59, 0.851)" });
    expect(parseBackdrop("color:000000ff")).toEqual({ kind: "color", css: "rgba(0, 0, 0, 1.000)" });
  });

  it("decodes the picture form with its fill", () => {
    expect(parseBackdrop("img:cover")).toEqual({ kind: "image", fill: "cover" });
    expect(parseBackdrop("img:contain")).toEqual({ kind: "image", fill: "contain" });
  });
});

describe("encodeColor", () => {
  it("encodes a hex and an opacity as the eight-digit string", () => {
    expect(encodeColor("#1e293b", 0.85)).toBe("color:1e293bd9");
    expect(encodeColor("112233", 1)).toBe("color:112233ff");
    expect(encodeColor("#112233", 0)).toBe("color:11223300");
  });

  it("clamps an out-of-range opacity and refuses a non-colour", () => {
    expect(encodeColor("#112233", 5)).toBe("color:112233ff");
    expect(encodeColor("#112233", -1)).toBe("color:11223300");
    expect(encodeColor("printer", 0.5)).toBeUndefined();
  });
});

describe("encodeImage", () => {
  it("names the fill the session carries", () => {
    expect(encodeImage("cover")).toBe("img:cover");
    expect(encodeImage("contain")).toBe("img:contain");
  });
});

describe("the stored picture", () => {
  it("round-trips per session", () => {
    writeStoredImage("s1", "data:image/webp;base64,AAA");
    writeStoredImage("s2", "data:image/webp;base64,BBB");
    expect(readStoredImage("s1")).toBe("data:image/webp;base64,AAA");
    expect(readStoredImage("s2")).toBe("data:image/webp;base64,BBB");
  });

  it("removes on a clear, and reads nothing through a missing key", () => {
    writeStoredImage("s1", "data:image/webp;base64,AAA");
    writeStoredImage("s1", undefined);
    expect(readStoredImage("s1")).toBeUndefined();
    expect(readStoredImage("nobody")).toBeUndefined();
  });
});
