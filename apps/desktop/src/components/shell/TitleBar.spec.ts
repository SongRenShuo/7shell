/**
 * The title bar's accessible names, over whichever tab is on screen.
 *
 * The bar is the frame's own chrome, so it is the same bar over every tab — and a name that only
 * exists while the workspace is the tab on screen is a name a screen reader loses the moment
 * somebody opens the settings. The sweep that scheduled this suite read the bar over a settings tab
 * and counted eight unnamed icon buttons; these cases read the same bar in the same shape (a
 * browser host, the vault unlocked, the settings tab active) and hold every button to a name.
 */
import { createPinia, setActivePinia } from "pinia";
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/runtime", () => ({ isDesktopRuntime: vi.fn(() => false) }));
vi.mock("@/lib/backend/tauri", () => ({
  appInfo: vi.fn(),
  settingsGet: vi.fn(),
  settingsSet: vi.fn(async () => {}),
  webviewSetZoom: vi.fn(),
  keysList: vi.fn(async () => []),
  sessionsList: vi.fn(async () => []),
  groupsList: vi.fn(async () => []),
}));

import TitleBar from "@/components/shell/TitleBar.vue";
import { i18n } from "@/i18n";
import { usePreferencesStore } from "@/stores/preferences";
import { useTerminalsStore } from "@/stores/terminals";
import { useVaultStore } from "@/stores/vault";

let host: HTMLDivElement;
let app: App | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
});

/** Draws the bar over a settings tab: the vault open, the page active, in a browser host. */
async function mountOverSettings(): Promise<void> {
  app = createApp({ render: () => h(TitleBar) })
    .use(createPinia())
    .use(i18n);
  app.mount(host);
  useVaultStore().state = "unlocked";
  useTerminalsStore().openSettings();
  await nextTick();
  await nextTick();
}

function barButtons(): HTMLButtonElement[] {
  const bar = host.querySelector("header");
  if (!bar) {
    throw new Error("the title bar was not drawn");
  }
  return [...bar.querySelectorAll("button")];
}

describe("the title bar's accessible names", () => {
  it("names every icon button over a settings tab, as it does over the workspace", async () => {
    await mountOverSettings();

    // The sweep counted eight: pin, transfers, batch, monitor, assistant, theme, settings, lock —
    // the row the unlocked vault draws in a browser host, where the window's own three buttons are
    // the platform's and the update entry is not offered. A ninth button joins with a name or the
    // count here says so.
    const buttons = barButtons();
    expect(buttons.length).toBe(8);

    for (const button of buttons) {
      const name = button.getAttribute("aria-label") ?? "";
      expect(
        name.trim(),
        `the ${button.dataset.settingsToggle ?? button.outerHTML.slice(0, 80)} button has a name`,
      ).not.toBe("");
    }
  });

  it("marks the settings page the bar is over, so the gear reads as where you are", async () => {
    await mountOverSettings();

    const gear = host.querySelector<HTMLButtonElement>("button[data-settings-toggle]");
    if (!gear) {
      throw new Error("the settings button was not drawn");
    }
    expect(gear.getAttribute("aria-label")).toBeTruthy();
    expect(gear.getAttribute("aria-current")).toBe("page");
  });

  it("names the tabs too when the strip lives in the bar, over a settings tab", async () => {
    // The strip can be drawn inside the bar rather than under it; its tab buttons are named by
    // their visible text either way, and the attribute makes the same answer readable as an
    // attribute wherever the bar is read.
    usePreferencesStore().tabPlacement = "titleBar";
    await mountOverSettings();

    for (const button of barButtons()) {
      const name = (button.getAttribute("aria-label") ?? "").trim() || (button.textContent ?? "").trim();
      expect(name, "every button the bar holds has a name").not.toBe("");
    }
  });
});
