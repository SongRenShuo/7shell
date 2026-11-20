/**
 * The desktop hands itself to the browser, against the real window.
 *
 * This is the one case that cannot be a component test: the handover crosses three processes — the
 * webview asks the application to start its loopback host, the host answers with a URL, and that
 * URL is a real HTTP service somebody else's browser can open. The browser here is this test
 * process, not a second window: it speaks HTTP and WebSocket to the host the application started,
 * which is exactly what a browser tab does.
 *
 * The vault case in `app.spec.ts` runs first (the `zz-` name), so a vault exists; a session is made
 * here if the run has none, because a handover is about a session.
 */
import { chromium, expect, test, type Page } from "@playwright/test";

const CDP_URL = process.env.SEVENSHELL_E2E_CDP ?? "http://127.0.0.1:9222";

type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

/** The application's own invoke, which is what the interface's buttons reach for. */
async function invokeOn(page: Page, command: string, args?: Record<string, unknown>): Promise<unknown> {
  return page.evaluate(
    async (input) => {
      const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
      return internals.invoke(input.command, input.args);
    },
    { command, args },
  );
}

test("the desktop hands itself to a browser over loopback, and the browser is refused without the token", async () => {
  test.setTimeout(120_000);

  const browser = await chromium.connectOverCDP(CDP_URL);
  const context = browser.contexts()[0];
  if (!context) {
    throw new Error("the application has no webview context");
  }
  const page = context.pages()[0] ?? (await context.waitForEvent("page"));

  await expect(page.getByRole("textbox", { name: "Search sessions" })).toBeVisible({ timeout: 30_000 });

  // A session to hand over. The run's earlier cases save several; one more is harmless and makes
  // this case independent of what they left behind.
  await page.getByRole("button", { name: "New session" }).click();
  const editor = page.getByRole("dialog");
  await editor.getByPlaceholder("Production web server").fill("handover-lab");
  await editor.getByPlaceholder("example.com").fill("127.0.0.1");
  await editor.getByPlaceholder("root").fill("labuser");
  await editor.getByRole("button", { name: "Save" }).click();
  await expect(editor).toHaveCount(0);

  const sessionId = await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: Invoke } }).__TAURI_INTERNALS__;
    const sessions = (await internals.invoke("sessions_list")) as { id: string; name: string }[];
    const found = sessions.find((session) => session.name === "handover-lab") ?? sessions[0];
    if (!found) {
      throw new Error("the run saved no session to hand over");
    }
    return found.id;
  });

  // The command the tab's chrome action calls — the one that does not open a browser, so a test
  // can hold the URL instead of a window nobody is watching.
  const url = (await invokeOn(page, "desktop_browser_url", { sessionId })) as string;
  expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]+&open=desktop:/);

  const [base, fragment] = url.split("#");
  const token = new URLSearchParams(fragment).get("token") ?? "";
  expect(token.length).toBeGreaterThan(0);

  // 1. The interface is served over real HTTP: the built page, not the webview's custom protocol.
  const served = await fetch(`${base}/`);
  expect(served.status).toBe(200);
  const html = await served.text();
  expect(html.toLowerCase()).toContain("<!doctype html");

  // 2. The same address without the token is refused — the token is the whole authentication story.
  const refused = await fetch(`${base}/`, { headers: { "x-sevenshell-token": "not-the-token" } });
  expect(refused.status, "a wrong token is refused").toBe(401);

  // 3. The event socket answers a real browser's upgrade with the token, and refuses without it.
  const socketUrl = `${base.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
  const opened = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(socketUrl);
    const settle = (answer: boolean): void => {
      socket.close();
      resolve(answer);
    };
    socket.addEventListener("open", () => settle(true));
    socket.addEventListener("error", () => settle(false));
    setTimeout(() => settle(false), 10_000);
  });
  expect(opened, "a browser presenting the token gets the event socket").toBe(true);

  // 4. Asking again reuses the running host: same port, same token — the card's "get the link
  //    again" is about a host that stepped down, not about a new one every press.
  const again = (await invokeOn(page, "desktop_browser_url", { sessionId })) as string;
  expect(again).toBe(url);
});
