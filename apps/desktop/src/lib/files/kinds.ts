/**
 * What kind of thing a listing row is, in the few buckets a quick filter can offer.
 *
 * The listing's *type column* is a sentence per row and the order module's business; this is the
 * coarser cut underneath it — the chips a reader presses to see only the pictures, say, in a
 * directory of a thousand names. A directory is its own bucket; everything else is classified by
 * its name's extension, because the server says nothing richer and a symlink to a picture is,
 * for somebody looking for pictures, a picture.
 */
import type { SftpEntry } from "@/types/session";

/** The buckets the filter chips offer, `all` being the no-filter state the panel holds. */
export type EntryKindBucket = "folder" | "document" | "image" | "archive" | "other";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "tif",
  "tiff",
  "avif",
  "heic",
]);

const ARCHIVE_EXTENSIONS = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "cab"]);

const DOCUMENT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "csv",
  "tsv",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "conf",
  "cfg",
  "log",
  "xml",
  "html",
  "htm",
  "css",
  "js",
  "mjs",
  "cjs",
  "ts",
  "tsx",
  "jsx",
  "vue",
  "sh",
  "bash",
  "zsh",
  "fish",
  "py",
  "rb",
  "pl",
  "php",
  "java",
  "kt",
  "go",
  "rs",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "sql",
  "env",
  "lock",
]);

/** The extension of a name, lowercased, or "" when the name carries none. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) {
    return "";
  }
  return name.slice(dot + 1).toLowerCase();
}

/** Which bucket a row falls into: a directory is a directory, the rest follow their extension. */
export function kindOf(entry: Pick<SftpEntry, "kind" | "name">): EntryKindBucket {
  if (entry.kind === "directory") {
    return "folder";
  }
  const extension = extensionOf(entry.name);
  if (IMAGE_EXTENSIONS.has(extension)) {
    return "image";
  }
  if (ARCHIVE_EXTENSIONS.has(extension)) {
    return "archive";
  }
  if (DOCUMENT_EXTENSIONS.has(extension)) {
    return "document";
  }
  return "other";
}
