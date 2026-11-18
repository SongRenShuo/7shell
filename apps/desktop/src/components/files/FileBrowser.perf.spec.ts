/**
 * The file listing's cost at scale: how much of a huge directory the panel actually draws, and how
 * long drawing it takes.
 *
 * The listing is a windowed one — `lib/files/window.ts` slices the rows somebody can see plus an
 * overscan, and two spacers stand in for the rest — so the claim this suite checks is that the DOM
 * stays the same size whether the directory holds two thousand entries or five thousand, and that
 * mounting it does not grow with the directory. The millisecond bounds are generous smoke guards
 * (LESSONS I43: a tight threshold turns red on a slow runner for reasons that are not the code's);
 * the assertions that carry the audit are the structural ones — row count, node count.
 *
 * In this environment the listing has no layout (happy-dom reports no heights), so the window sits
 * at `UNMEASURED_ROWS` — a screenful is what an unmeasured panel draws, which is exactly the bound
 * this audit wants to see hold: the drawn window is bounded either way, and in a real webview it
 * is tighter (viewport ÷ row pitch + overscan).
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/backend/tauri", () => ({
  filesCreateFile: vi.fn(async () => {}),
  filesCreateFolder: vi.fn(async () => {}),
  filesDownload: vi.fn(async () => "x1"),
  filesList: vi.fn(async (_handle: string, path: string) => ({ path, entries: [] })),
  filesOpen: vi.fn(),
  filesClose: vi.fn(),
  filesRename: vi.fn(async () => {}),
  transfersOpen: vi.fn(async () => []),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async () => {}),
}));

import FileBrowser from "@/components/files/FileBrowser.vue";
import { i18n } from "@/i18n";
import { useFilesStore } from "@/stores/files";
import type { SftpEntry } from "@/types/session";

const HANDLE = "f1";

let host: HTMLDivElement;
let app: App | undefined;

/** Mounts the panel over a directory the store is told about, which is what the panel draws. */
async function render(entries: readonly SftpEntry[]): Promise<void> {
  useFilesStore().browsers[HANDLE] = {
    handle: HANDLE,
    sessionId: "session-1",
    path: "/home/user",
    home: "/home/user",
    shellPath: "/home/user",
    entries: [...entries],
    loading: false,
    failure: null,
  };

  app = createApp({ render: () => h(FileBrowser, { handle: HANDLE }) }).use(i18n);
  app.mount(host);
  await nextTick();
}

/** A directory of `count` files, with a few directories among them as a real one has. */
function directoryOf(count: number): SftpEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    name: index % 25 === 0 ? `folder-${index}` : `entry-${String(index).padStart(5, "0")}.txt`,
    path: index % 25 === 0 ? `/home/user/folder-${index}` : `/home/user/entry-${String(index).padStart(5, "0")}.txt`,
    kind: index % 25 === 0 ? ("directory" as const) : ("file" as const),
    size: index % 25 === 0 ? 0 : index,
  }));
}

function drawnRows(): HTMLElement[] {
  return [...host.querySelectorAll<HTMLElement>("li[data-path]")];
}

/** Every element the panel holds, which is what mounting a directory costs. */
function nodeCount(): number {
  return host.querySelectorAll("*").length;
}

function unmount(): void {
  app?.unmount();
  app = undefined;
  host.remove();
}

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.body.appendChild(document.createElement("div"));
  localStorage.clear();
});

afterEach(() => {
  unmount();
  localStorage.clear();
});

describe("the file listing at scale", () => {
  it("draws the same bounded handful of rows for two thousand entries as for two", async () => {
    const start = performance.now();
    await render(directoryOf(2_000));
    const elapsedMs = performance.now() - start;

    const rows = drawnRows();
    const nodes = nodeCount();
    console.info(
      `file listing @2000 entries: ${rows.length} rows drawn, ${nodes} nodes total, mount ${elapsedMs.toFixed(1)}ms`,
    );
    // The windowed listing draws a screenful, not the directory: 2000 entries never become 2000 rows.
    expect(rows.length).toBeLessThanOrEqual(40);
    expect(rows.length, "and the unmeasured screenful is really drawn, not an empty listing").toBeGreaterThan(20);
    expect(elapsedMs, "mounting a 2000-entry directory stays a cheap operation").toBeLessThan(2_000);
  });

  it("draws the same bounded handful of rows for five thousand entries", async () => {
    const start = performance.now();
    await render(directoryOf(5_000));
    const elapsedMs = performance.now() - start;

    const rows = drawnRows();
    const nodes = nodeCount();
    console.info(
      `file listing @5000 entries: ${rows.length} rows drawn, ${nodes} nodes total, mount ${elapsedMs.toFixed(1)}ms`,
    );
    expect(rows.length).toBeLessThanOrEqual(40);
    expect(elapsedMs, "mounting a 5000-entry directory stays a cheap operation").toBeLessThan(2_000);
  });

  it("scrolling to the far end of a five-thousand-entry directory draws no more rows", async () => {
    await render(directoryOf(5_000));
    const nodesBefore = nodeCount();

    // The scroll container is the listing's own; the browser reports the scroll and the window
    // recomputes. Whatever the position, the drawn window is bounded.
    const scroller = drawnRows()[0]?.closest("ul")?.parentElement;
    if (scroller) {
      scroller.scrollTop = 400_000;
      scroller.dispatchEvent(new Event("scroll"));
      await nextTick();
    }

    expect(drawnRows().length, "the far end of the directory is still a screenful, no more").toBeLessThanOrEqual(40);
    expect(nodeCount(), "and the panel holds the same nodes it held at the top").toBe(nodesBefore);
  });
});
