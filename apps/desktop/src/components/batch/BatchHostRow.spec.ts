/**
 * One batch row's light and its readings.
 *
 * The run mechanics live in the store's own suite; what is checked here is how the row says where
 * a host stands — the desktop's dot light, hollow until the host has run, filled green when the
 * command succeeded, filled red when it did not — and that the row's numbers (the exit code, the
 * duration) wear the numbers track rather than the monospace one, so a reading that changes does
 * not shuffle its own digits.
 */
import { type App, createApp, h, nextTick } from "vue";
import { afterEach, describe, expect, it } from "vitest";

import BatchHostRow from "@/components/batch/BatchHostRow.vue";
import { i18n } from "@/i18n";
import type { BatchRow } from "@/stores/batch";
import type { Session } from "@/types/session";

const SESSION: Session = {
  id: "s1",
  name: "web",
  protocol: "ssh",
  host: "web.example",
  port: 22,
  user: "root",
  auth: { method: "password", hasSecret: true },
  terminal: {
    terminalType: "xterm-256color",
    keepaliveSeconds: 0,
    encoding: "utf-8",
    backspace: "del",
    forwardAgent: false,
    record: false,
  },
  updatedAt: 0,
};

function row(status: BatchRow["status"], result: BatchRow["result"] = null): BatchRow {
  return { sessionId: "s1", sessionName: "web", session: SESSION, status, result };
}

function ranRow(exitCode: number | null): BatchRow {
  return row("done", {
    sessionId: "s1",
    sessionName: "web",
    outcome: { kind: "ran", exitCode, stdout: "", stderr: "" },
    durationMs: 1250,
  });
}

let app: App | undefined;
let host: HTMLDivElement | undefined;

async function mountRow(fixture: BatchRow): Promise<void> {
  app?.unmount();
  host?.remove();
  host = document.createElement("div");
  document.body.append(host);
  app = createApp({ render: () => h(BatchHostRow, { row: fixture, retrying: false }) });
  app.use(i18n);
  app.mount(host);
  await nextTick();
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host?.remove();
  document.body.innerHTML = "";
});

function light(): HTMLElement {
  const found = document.querySelector<HTMLElement>("[data-batch-row-light]");
  if (!found) {
    throw new Error("no status light was drawn");
  }
  return found;
}

describe("the batch row's status light", () => {
  it("a host that has not run draws the hollow light — shape says it never ran", async () => {
    await mountRow(row("pending"));
    expect(light().className).toContain("border");
    expect(light().className).not.toContain("bg-");
    expect(light().dataset.batchState).toBe("pending");
  });

  it("a host that answered and succeeded draws the filled green light", async () => {
    await mountRow(ranRow(0));
    expect(light().className).toContain("bg-success");
    expect(light().dataset.batchState).toBe("success");
  });

  it("a non-zero exit is the filled red light, as is a host that never answered", async () => {
    await mountRow(ranRow(3));
    expect(light().className).toContain("bg-destructive");
    expect(light().dataset.batchState).toBe("failed");

    await mountRow(
      row("done", {
        sessionId: "s1",
        sessionName: "web",
        outcome: {
          kind: "failed",
          error: { code: "SESSION-CLOSED", messageKey: "errors.session.closed", messageParams: {} },
        },
        durationMs: 40,
      }),
    );
    expect(light().className).toContain("bg-destructive");
    expect(light().dataset.batchState).toBe("failed");
  });

  it("a row still running keeps the spinner, not a light that claims a settled state", async () => {
    await mountRow(row("running"));
    expect(document.querySelector("[data-batch-row-light]")).toBeNull();
    expect(document.querySelector("[data-batch-row-light], .animate-spin")).not.toBeNull();
  });

  it("the result readings wear the numbers track: the exit code and the duration", async () => {
    await mountRow(ranRow(0));
    const readings = [...document.querySelectorAll<HTMLElement>("span.nums")];
    expect(readings.some((entry) => entry.textContent?.includes("exit 0"))).toBe(true);
    expect(readings.some((entry) => entry.textContent?.includes("1.3 s"))).toBe(true);
    // And nothing in the row's readings drags the monospace face in for a number.
    for (const reading of readings) {
      expect(reading.className).not.toContain("font-mono");
    }
  });
});
