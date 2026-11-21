/**
 * The directory's search field: what typing into it does to the listing, and what it does not.
 *
 * The field filters the entries the panel has already loaded — no second round trip, nothing the
 * store keeps — so what can only be seen here is that wiring: that the rows the listing draws shrink
 * to the matches, that the count says how many, that clearing puts the whole directory back, and
 * that a menu opened over the filtered rows still acts on exactly the rows the person can see.
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
import { useContextMenu } from "@/composables/useContextMenu";
import { i18n } from "@/i18n";
import { filesDownload } from "@/lib/backend/tauri";
import type { MenuEntry } from "@/lib/menu/types";
import { useFilesStore } from "@/stores/files";
import type { SftpEntry } from "@/types/session";

const HANDLE = "f1";

const entries: SftpEntry[] = [
  { name: "logs", path: "/home/user/logs", kind: "directory", size: 0 },
  { name: "notes.txt", path: "/home/user/notes.txt", kind: "file", size: 12 },
  { name: "LOGS-old.txt", path: "/home/user/LOGS-old.txt", kind: "file", size: 30 },
  { name: "readme.md", path: "/home/user/readme.md", kind: "file", size: 5 },
];

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

/** Types into the search field the way a person does, and hands the field back. */
async function typeSearch(query: string): Promise<HTMLInputElement> {
  const field = host.querySelector<HTMLInputElement>("[data-search-input]");
  if (field === null) {
    throw new Error("the search field is not on the strip");
  }
  field.value = query;
  field.dispatchEvent(new Event("input"));
  await nextTick();
  return field;
}

/** The search field's clear button, which is how a person empties it with the pointer. */
function clearButton(): HTMLButtonElement {
  const button = host.querySelector<HTMLButtonElement>(
    '[data-search-input] ~ button, button[aria-label="Clear search"]',
  );
  if (button === null) {
    throw new Error("the search field has no clear button");
  }
  return button;
}

/** The count the strip shows while the field is filtering, and whether it is there at all. */
function matchCount(): string | null {
  return host.querySelector<HTMLElement>("[data-search-count]")?.textContent?.trim() ?? null;
}

function listing(): HTMLElement | null {
  return host.querySelector("ul.p-1\\.5")?.parentElement ?? null;
}

/** The rows as they are drawn, by file name, which is the order the headings decide. */
function drawn(): string[] {
  return [...(listing()?.querySelectorAll<HTMLElement>("li[data-path]") ?? [])].map(
    (row) => row.dataset.path?.split("/").pop() ?? "",
  );
}

/** The paths drawn as selected, in the order the listing draws them. */
function selectedPaths(): string[] {
  return [...(listing()?.querySelectorAll<HTMLElement>("li > div") ?? [])]
    .filter((row) => row.getAttribute("aria-selected") === "true")
    .map((row) => row.parentElement?.dataset.path ?? "");
}

function rows(): HTMLElement[] {
  return [...(listing()?.querySelectorAll<HTMLElement>("li > div") ?? [])];
}

/** Right-clicks the nth row of the listing, which is how a row's own menu is opened. */
async function rightClickRow(index: number): Promise<readonly MenuEntry[]> {
  const row = rows()[index];
  row?.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await nextTick();
  return useContextMenu().entries.value;
}

function pick(entries: readonly MenuEntry[], id: string): { run: () => void } {
  const found = entries.find((item) => item.kind === "action" && item.id === id);
  if (!found || found.kind !== "action") {
    throw new Error(`the menu has no entry called ${id}`);
  }
  return found;
}

/** Clicks a row, with whichever modifiers the gesture calls for. */
async function clickRow(index: number, ...modifiers: ("ctrl" | "shift")[]): Promise<void> {
  rows()[index]?.dispatchEvent(
    new MouseEvent("click", {
      bubbles: true,
      detail: 1,
      ctrlKey: modifiers.includes("ctrl"),
      shiftKey: modifiers.includes("shift"),
    }),
  );
  await nextTick();
}

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.createElement("div");
  document.body.append(host);
  vi.mocked(filesDownload).mockClear();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
});

describe("the directory's search field", () => {
  it("narrows the listing to the names that carry what was typed, however it is capitalised", async () => {
    await render(entries);

    expect(drawn()).toEqual(["logs", "LOGS-old.txt", "notes.txt", "readme.md"]);
    await typeSearch("logs");
    expect(drawn()).toEqual(["logs", "LOGS-old.txt"]);
  });

  it("says how many entries survived the filter, and only while it is filtering", async () => {
    await render(entries);

    expect(matchCount(), "an idle field says nothing about counts").toBeNull();
    await typeSearch("logs");
    expect(matchCount()).toBe("2 match(es)");
    await typeSearch("notes.txt");
    expect(matchCount()).toBe("1 match(es)");
  });

  it("sorts the matches the way the headings say, not the way the directory sent them", async () => {
    await render(entries);
    await typeSearch("txt");

    // Ascending by name: LOGS-old.txt before notes.txt, the directory's own order be damned.
    expect(drawn()).toEqual(["LOGS-old.txt", "notes.txt"]);
  });

  it("hands the whole directory back when the field is emptied, by button or by Escape", async () => {
    await render(entries);
    const field = await typeSearch("logs");
    expect(drawn()).toEqual(["logs", "LOGS-old.txt"]);

    clearButton().click();
    await nextTick();
    expect(drawn(), "the X button brings every entry back").toEqual(["logs", "LOGS-old.txt", "notes.txt", "readme.md"]);
    expect(matchCount(), "and the count goes with the filter").toBeNull();

    await typeSearch("logs");
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await nextTick();
    expect(drawn(), "Escape empties the field the way a find bar does").toEqual([
      "logs",
      "LOGS-old.txt",
      "notes.txt",
      "readme.md",
    ]);
    expect(field.value).toBe("");
  });

  it("tells the person when nothing matches, naming what was typed", async () => {
    await render(entries);

    await typeSearch("no-such-entry");
    // The empty states are list rows in the merged manager's markup; the sentence is what matters.
    const sentences = [...(listing()?.querySelectorAll<HTMLElement>("li") ?? [])].map((row) => row.textContent?.trim());
    expect(sentences).toContain("No entries matching no-such-entry.");
  });

  it("leaves the empty directory its own sentence, not the search field's", async () => {
    await render([]);
    const sentences = [...(listing()?.querySelectorAll<HTMLElement>("li") ?? [])].map((row) => row.textContent?.trim());
    expect(sentences).toContain("This directory is empty.");
    expect(sentences.some((sentence) => sentence?.startsWith("No entries matching"))).toBe(false);
  });

  it("keeps the selection and the menus inside the filtered rows", async () => {
    await render(entries);
    await typeSearch("txt");

    await clickRow(0);
    await clickRow(1, "ctrl");
    expect(selectedPaths()).toEqual(["/home/user/LOGS-old.txt", "/home/user/notes.txt"]);

    const menu = await rightClickRow(1);
    pick(menu, "download").run();
    await nextTick();

    // The whole selection travels — both rows the filter leaves visible, and nothing hidden.
    // Several files unpacked ask where to put them, so the dialog is a folder picker's sentence.
    expect(vi.mocked(filesDownload)).toHaveBeenCalledWith(
      HANDLE,
      ["/home/user/LOGS-old.txt", "/home/user/notes.txt"],
      "Choose the folder to download into",
      "",
      false,
    );
  });

  it("empties the field when the panel walks into another directory", async () => {
    await render(entries);
    await typeSearch("logs");
    expect(drawn()).toEqual(["logs", "LOGS-old.txt"]);

    // The store answers the navigation; the field follows the panel, not the old directory.
    // The browser is the one `render` opened, so the entry is there: the assertion is what tells
    // the strict indexer so, and keeping it leaves every other field of the record required.
    const files = useFilesStore();
    files.browsers[HANDLE] = {
      ...files.browsers[HANDLE]!,
      path: "/var/log",
      entries: [{ name: "journal", path: "/var/log/journal", kind: "directory", size: 0 }],
    };
    await nextTick();

    const field = host.querySelector<HTMLInputElement>("[data-search-input]");
    expect(field?.value).toBe("");
    expect(drawn()).toEqual(["journal"]);
  });
});
