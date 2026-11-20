/**
 * The desktop hands itself to the browser, against the real window.
 *
 * This is the one case that cannot be a component test: the handover crosses three processes — the
 * webview asks the application to start its loopback host, the host answers with a URL, and that
 * URL is a real HTTP service another program can open. The browser here is this test process: it
 * speaks HTTP and WebSocket to the host the application started, which is exactly what a browser
 * tab does.
 *
 * What the token does and does not guard is part of the contract, and this case pins both halves:
 * the page itself is served without one — a shell that demanded a token before showing the form
 * that carries it could never be opened — and every call and the event socket are refused without
 * it.
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

  const unlock = page.getByPlaceholder("Vault password");
  if (await unlock.isVisible().catch(() => false)) {
    await unlock.fill("seven-shell-e2e");
    await page.getByRole("button", { name: "Unlock" }).click();
  }
  await expect(page.getByRole("textbox", { name: "Search sessions" })).toBeVisible({ timeout: 30_000 });

  // A session to hand over. The run's earlier cases save several; one more is harmless and makes
  // this case independent of what they left behind. The button is asked for inside the sidebar:
  // the empty desk offers one of its own, and two answers to one name is what strict mode refuses.
  const sidebar = page.locator("[data-session-list]").locator("xpath=ancestor::aside[1]");
  await sidebar.getByRole("button", { name: "New session" }).click();
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

  // The URL names a directory with its trailing slash; every route below is asked for from the
  // origin, so the slash is taken off once rather than doubled in every path.
  const [address, fragment] = url.split("#");
  const base = address.replace(/\/$/, "");
  const token = new URLSearchParams(fragment).get("token") ?? "";
  expect(token.length).toBeGreaterThan(0);

  // 1. The interface is served over real HTTP: the built page, not the webview's custom protocol.
  //    No token on this request, deliberately — the shell is what carries the token in its fragment.
  const served = await fetch(`${base}/`);
  expect(served.status).toBe(200);
  expect((await served.text()).toLowerCase()).toContain("<!doctype html");

  // 2. Every call is refused without the token, and with the wrong one.
  const call = (headers: Record<string, string>): Promise<Response> =>
    fetch(`${base}/invoke`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ cmd: "sessions_list", args: {} }),
    });
  expect((await call({})).status, "no token is refused").toBe(401);
  expect((await call({ authorization: "Bearer not-the-token" })).status, "a wrong token is refused").toBe(401);

  // 3. With the token the same call answers — this is the API a browser tab lives on.
  const answered = await call({ authorization: `Bearer ${token}` });
  expect(answered.status).toBe(200);
  const sessions = (await answered.json()) as { id: string }[];
  expect(Array.isArray(sessions)).toBe(true);
  expect(sessions.some((session) => session.id === sessionId)).toBe(true);

  // 4. The event socket answers a real browser's upgrade with the token.
  const socketUrl = `${base.replace(/^http/, "ws")}/events?token=${encodeURIComponent(token)}`;
  const opened = await new Promise<boolean>((resolve) => {
    const socket = new WebSocket(socketUrl);
    let settled = false;
    const settle = (answer: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      // A socket that failed is already closing; asking it to close again throws, and an exception
      // inside an event listener is what takes the whole worker down with it.
      try {
        socket.close();
      } catch {
        // Nothing left to close.
      }
      resolve(answer);
    };
    socket.addEventListener("open", () => settle(true));
    socket.addEventListener("error", () => settle(false));
    setTimeout(() => settle(false), 10_000);
  });
  expect(opened, "a browser presenting the token gets the event socket").toBe(true);

  // 5. Asking again reuses the running host: same port, same token — the card's "get the link
  //    again" is about a host that stepped down, not about a new one every press.
  const again = (await invokeOn(page, "desktop_browser_url", { sessionId })) as string;
  expect(again).toBe(url);
});
