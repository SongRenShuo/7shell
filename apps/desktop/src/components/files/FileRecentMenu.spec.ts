/**
 * The recent-directories popover, as a person meets it: opening it after the session has walked
 * somewhere, jumping from it, and clearing it.
 *
 * The list rules — the dedupe, the cap, the session isolation — are `lib/files/panelMemory`'s
 * business; what can only be seen here is the wiring: that the popover reads the session's list
 * when it opens, that a row announces the jump it was pressed for, and that clearing leaves the
 * empty sentence, not a blank box.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import FileRecentMenu from "@/components/files/FileRecentMenu.vue";
import { i18n } from "@/i18n";
import { pushRecent } from "@/lib/files/panelMemory";

const SESSION = "session-1";

let host: HTMLDivElement;
let app: App | undefined;
let jumps: string[];

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  document.body.innerHTML = "";
});

/** Mounts the menu over one session, collecting the paths its rows announce. */
async function render(sessionId = SESSION): Promise<void> {
  jumps = [];
  app = createApp({
    render: () =>
      h(FileRecentMenu, {
        sessionId,
        onJump: (to: string) => jumps.push(to),
      }),
  }).use(i18n);
  host = document.createElement("div");
  document.body.append(host);
  app.mount(host);
  await nextTick();
}

/** A click followed by the two ticks Vue needs to draw whatever the click opened. */
async function press(selector: string): Promise<void> {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) throw new Error(`nothing on screen matches ${selector}`);
  target.click();
  await nextTick();
  await nextTick();
}

function entries(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("[data-recent-entry]")];
}

describe("the recent menu", () => {
  it("opens onto the empty sentence when the session has walked nowhere", async () => {
    await render();
    await press("[data-recent-menu]");

    expect(document.querySelector("[data-recent-empty]")?.textContent).toContain("No recent directories yet.");
    expect(entries()).toHaveLength(0);
  });

  it("lists the session's walks, newest first, and jumps when a row is pressed", async () => {
    pushRecent(SESSION, "/var/log");
    pushRecent(SESSION, "/home/user");
    await render();
    await press("[data-recent-menu]");

    const rows = entries();
    const first = rows[0];
    const second = rows[1];
    if (first === undefined || second === undefined) throw new Error("the list does not show both walks");
    expect(first.textContent?.trim()).toBe("user");
    expect(second.textContent?.trim()).toBe("log");

    second.click();
    await nextTick();
    expect(jumps).toEqual(["/var/log"]);
  });

  it("clears the list and shows the empty sentence afterwards", async () => {
    pushRecent(SESSION, "/var/log");
    await render();
    await press("[data-recent-menu]");
    await press("[data-recent-clear]");

    expect(entries()).toHaveLength(0);
    expect(document.querySelector("[data-recent-empty]")).not.toBeNull();
  });

  it("never reads another session's walks", async () => {
    pushRecent("session-2", "/etc");
    await render(SESSION);
    await press("[data-recent-menu]");

    expect(entries()).toHaveLength(0);
  });
});
