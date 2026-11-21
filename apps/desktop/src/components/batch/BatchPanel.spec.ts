/**
 * The batch panel's history, as a person meets it: a run lands in the list, the popover offers it
 * back, the arrows walk it from the textarea, and clearing leaves the empty sentence.
 *
 * The run mechanics — the risk verdict, the per-host rows — are the store's own suite; what can
 * only be seen here is the wiring between a run and the list that remembers it.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => true) }));
vi.mock("@/lib/batch/bus", () => ({
  startBatchBus: vi.fn(async () => () => {}),
  onBatchProgress: vi.fn(() => () => {}),
}));
vi.mock("@/lib/backend/tauri", () => ({
  batchRun: vi.fn(async () => ({ rows: [] })),
  commandClassify: vi.fn(async () => ({ level: "safe", reasons: [] })),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async () => {}),
}));

import BatchPanel from "@/components/batch/BatchPanel.vue";
import { i18n } from "@/i18n";
import { clearHistory, loadHistory, pushHistory } from "@/lib/batch/history";
import { useBatchStore } from "@/stores/batch";
import { useSessionEditorStore } from "@/stores/sessionEditor";
import { useSessionsStore } from "@/stores/sessions";

const HOST = { id: "s1", name: "web", user: "root", host: "web.example", port: 22, protocol: "ssh" };

let host: HTMLDivElement;
let app: App | undefined;

beforeEach(() => {
  window.localStorage.clear();
  setActivePinia(createPinia());
  const library = useSessionsStore();
  library.sessions = [{ ...HOST }] as never;
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  document.body.innerHTML = "";
});

async function render(): Promise<void> {
  app = createApp({ render: () => h(BatchPanel) }).use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** A click followed by the two ticks Vue needs to draw whatever the click opened or changed. */
async function press(selector: string): Promise<HTMLElement> {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`nothing on screen matches ${selector}`);
  target.click();
  await nextTick();
  await nextTick();
  return target;
}

async function typeCommand(command: string): Promise<void> {
  const field = document.querySelector<HTMLTextAreaElement>("[data-batch-command]");
  if (!field) throw new Error("no command box on screen");
  field.value = command;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  await nextTick();
}

describe("the batch panel's history", () => {
  it("records a run into the list the popover offers", async () => {
    await render();
    const store = useBatchStore();
    store.toggle("s1");
    await typeCommand("uptime");

    // The run button is the recording act; press it with the box filled.
    const run = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
      button.textContent?.includes("Run"),
    );
    if (!run) throw new Error("no run button");
    run.click();
    await nextTick();
    await nextTick();

    expect(loadHistory()).toEqual(["uptime"]);
  });

  it("lists past commands in the popover and puts one back when pressed", async () => {
    clearHistory();
    await render();
    const store = useBatchStore();
    store.toggle("s1");
    await typeCommand("free -m");
    const run = [...document.querySelectorAll<HTMLElement>("button")].find((button) =>
      button.textContent?.includes("Run"),
    );
    run!.click();
    await nextTick();
    await nextTick();

    await press("[data-batch-history]");
    const entry = document.querySelector<HTMLElement>("[data-batch-history-entry]");
    expect(entry?.textContent?.trim()).toBe("free -m");

    entry!.click();
    await nextTick();
    const field = document.querySelector<HTMLTextAreaElement>("[data-batch-command]");
    expect(field?.value).toBe("free -m");
  });

  it("walks the history with the arrow keys from the first line of the box", async () => {
    pushHistory("uptime");
    pushHistory("free -m");
    await render();

    const field = document.querySelector<HTMLTextAreaElement>("[data-batch-command]");
    if (!field) throw new Error("no command box on screen");
    field.selectionStart = 0;
    field.selectionEnd = 0;
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    await nextTick();
    expect(field.value, "one press back is the newest command").toBe("free -m");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true }));
    await nextTick();
    expect(field.value, "a second press is the one before it").toBe("uptime");

    field.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await nextTick();
    expect(field.value, "and forward again").toBe("free -m");
  });

  it("clears the list from the popover and shows the empty sentence", async () => {
    pushHistory("uptime");
    await render();
    await press("[data-batch-history]");
    await press("[data-batch-history-clear]");

    expect(loadHistory()).toEqual([]);
    expect(document.querySelector("[data-batch-history-empty]")?.textContent).toContain("No commands yet.");
  });
});

describe("the batch panel's host picker", () => {
  it("says a host comes from the session library, and hands over the act that adds one", async () => {
    const library = useSessionsStore();
    library.sessions = [];
    await render();

    const empty = document.querySelector("[data-batch-hosts-empty]");
    if (!empty) throw new Error("an empty library drew no word about it");
    expect(empty.textContent).toContain("The session library has no saved sessions yet.");

    const entry = document.querySelector<HTMLElement>("[data-batch-new-session]");
    if (!entry) throw new Error("the empty state offers no way in");
    entry.click();
    await nextTick();
    expect(useSessionEditorStore().open, "the entry opens the editor a new session is written in").toBe(true);
  });

  it("tells a library with sessions apart from one with none batchable", async () => {
    // The saved session is a console a batch cannot ride, so "no sessions saved" would be a lie:
    // the library has one, and the news is that it is not the kind this list can offer.
    const library = useSessionsStore();
    library.sessions = [{ ...HOST, id: "s2", protocol: "telnet" }] as never;
    await render();

    const empty = document.querySelector("[data-batch-hosts-empty]");
    if (!empty) throw new Error("a library without an SSH session drew no word about it");
    expect(empty.textContent).toContain("None of the saved sessions speak SSH.");
    expect(document.querySelector("[data-batch-new-session]")).not.toBeNull();
  });
});

describe("the batch panel's results empty state", () => {
  it("no run yet draws the empty state, and its way out is the command box", async () => {
    await render();
    const empty = document.querySelector("[data-batch-empty]");
    if (!empty) throw new Error("the results area drew no empty state");
    expect(empty.textContent).toContain("Pick the hosts on the left");

    // The one act that starts a run the picker has not already answered: write the command.
    const write = document.querySelector<HTMLElement>("[data-batch-empty-write]");
    if (!write) throw new Error("the empty state offers no way to the command box");
    write.click();
    await nextTick();
    const field = document.querySelector<HTMLTextAreaElement>("[data-batch-command]");
    expect(field, "the command box is on screen").not.toBeNull();
    expect(document.activeElement).toBe(field);
  });
});
