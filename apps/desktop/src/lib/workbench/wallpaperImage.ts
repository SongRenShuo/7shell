/**
 * The wallpapers a desktop can wear, said as values that travel in the session's own string.
 *
 * The session field has always been a plain string — the four gradient ids — and it stays one:
 * a solid colour encodes as `color:` plus an 8-digit hex (the alpha is the opacity the person
 * chose), a custom picture encodes as `img:` plus the fill mode, and an unknown string keeps
 * meaning "the interface's own background", which is the answer it has meant since before the
 * field had rules. The picture's bytes never enter the vault — a 1080p photograph would inflate
 * an encrypted document by half a megabyte — they live in the WebView's own storage beside the
 * window memory and the icon order, keyed by session: the picture is a face this device shows,
 * and the session carries only the decision to show one.
 */

/** What a session's wallpaper string turns into. */
export type WorkbenchBackdrop =
  | { kind: "gradient"; id: string }
  | { kind: "color"; css: string }
  | { kind: "image"; fill: "cover" | "contain" };

/** The four gradients the build draws, which the pane's settings row and the editor both name. */
export const GRADIENT_IDS = ["aurora", "dawn", "forest", "plain"] as const;

/**
 * Reads a wallpaper string into the backdrop it names, or nothing for the interface's default.
 *
 * A string this build does not understand — an older build's plain id that no longer draws, a hand
 * edit, a future form — is the same as nothing: the interface's own background, which has always
 * been the answer for "not one of ours".
 */
export function parseBackdrop(value: string | null | undefined): WorkbenchBackdrop | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if ((GRADIENT_IDS as readonly string[]).includes(value)) {
    return { kind: "gradient", id: value };
  }
  if (value.startsWith("color:")) {
    const hex = value.slice("color:".length);
    if (!/^[0-9a-fA-F]{8}$/.test(hex)) {
      return undefined;
    }
    const r = Number.parseInt(hex.slice(0, 2), 16);
    const g = Number.parseInt(hex.slice(2, 4), 16);
    const b = Number.parseInt(hex.slice(4, 6), 16);
    const a = Number.parseInt(hex.slice(6, 8), 16) / 255;
    return { kind: "color", css: `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})` };
  }
  if (value.startsWith("img:")) {
    const fill = value.slice("img:".length);
    return fill === "cover" || fill === "contain" ? { kind: "image", fill } : undefined;
  }
  return undefined;
}

/** Encodes a colour and an opacity (0-1) as the wallpaper string the colour form stores. */
export function encodeColor(hex: string, opacity: number): string | undefined {
  const body = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (body === null) {
    return undefined;
  }
  const clamped = Math.round(Math.min(1, Math.max(0, opacity)) * 255);
  const alpha = clamped.toString(16).padStart(2, "0");
  return `color:${body[1]}${alpha}`.toLowerCase();
}

/** Encodes the custom-picture form: the decision to show one, and how it fills the desk. */
export function encodeImage(fill: "cover" | "contain"): string {
  return `img:${fill}`;
}

/** The storage key the picture's bytes live under, per session. */
function imageKey(sessionId: string): string {
  return `sevenshell-workbench-wallpaper-img:${sessionId}`;
}

/** Reads this session's stored picture, or nothing when storage holds none. */
export function readStoredImage(sessionId: string): string | undefined {
  try {
    const value = localStorage.getItem(imageKey(sessionId));
    return value === null || value === "" ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Writes this session's picture, or clears it when handed nothing. */
export function writeStoredImage(sessionId: string, dataUrl: string | undefined): void {
  try {
    if (dataUrl === undefined) {
      localStorage.removeItem(imageKey(sessionId));
    } else {
      localStorage.setItem(imageKey(sessionId), dataUrl);
    }
  } catch {
    // A storage that refuses (a full quota among them) costs the picture, not the desktop: the
    // session keeps its decision, and the desk falls back to the interface's own background.
  }
}

/** The colour the settings' picker starts from, when nothing has been picked yet on this desk. */
export const DEFAULT_DRAFT_COLOR = "#1e293b";

/** The opacity the settings' slider starts from. */
export const DEFAULT_DRAFT_OPACITY = 0.85;

/** The most a stored picture may weigh: localStorage budgets, not disk budgets. */
const MAX_STORED_BYTES = 512 * 1024;

/** The desk's longest edge: a photograph larger than this is scaled down before encoding. */
const MAX_EDGE = 1920;

/**
 * Turns a picked file into a data URL that fits the storage budget.
 *
 * The picture is drawn onto a canvas at the desk's scale (a 4000×3000 photograph becomes a
 * 1920-wide one — a backdrop has no use for the extra pixels), then encoded, backing the quality
 * off until the bytes fit. If even the floor does not fit, the last encoding is returned anyway:
 * a slightly-over-budget picture that the storage refuses is worse than one that is a little
 * larger than ideal but works, and the storage's own failure path is the honest backstop.
 */
export async function fileToBackdrop(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) {
    bitmap.close();
    throw new Error("the canvas would not draw");
  }
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  let quality = 0.9;
  let url = canvas.toDataURL("image/webp", quality);
  while (url.length * 0.75 > MAX_STORED_BYTES && quality > 0.5) {
    quality -= 0.1;
    url = canvas.toDataURL("image/webp", quality);
  }
  return url;
}
