# PIP-0001: The browser host embeds in the app

- **Status:** Accepted
- **Date:** 2026-11-20
- **Affects:** `sevenshell-web` (bin → lib + bin), `src-tauri` (new embedded host module), one Tauri command

## Summary

Embed the `sevenshell-web` router inside the Tauri app process as an **on-demand, loopback-only
listener** so the running app can hand a desktop session to the system browser ("open this desktop
in a browser"), collapsing the in-app desktop tab to a stub. The feature is off until used: no
entry point pressed, no listener, no behaviour change.

## Background

- `crates/sevenshell-web` (bin `sshell-web`) already serves the whole interface over loopback with
  a per-run random token and answers the full backend contract (`main.rs:1-8`, router at
  `main.rs:1773`, `Ipv4Addr::LOCALHOST` bind at `main.rs:1789`). It is bin-only — no `[lib]` — so
  the app cannot reuse it.
- The app already runs an in-process axum HTTP server with the same trust shape: the MCP endpoint
  (`src-tauri/src/mcp/server.rs`) binds loopback, compares tokens without `==`, refuses everything
  without one (`server.rs:14-21,140-149`), and takes the app's `Arc<Core>` directly
  (`server.rs:220`).
- The app holds exactly one core (`state.rs:477 core_arc()` → `Arc<Core>`) plus an `Arc<Vault>` —
  the same two objects the web host's handlers want. Handing "this connection" to a sidecar
  process would instead mean re-configuring it in a second vault.
- Renderer cost of an in-app desktop tab is 63.1–79.3 MB private bytes (phase-four CDP
  measurements); the browser mode moves that budget to a browser tab and shrinks the app's own
  process tree.

Charter: [开发计划/20261120-0203-linux桌面七期浏览器打开模式-开发计划.md](../开发计划/20261120-0203-linux桌面七期浏览器打开模式-开发计划.md) (decision D1 route A, D4 lifecycle, D5 exposure, D6 this PIP).

## Proposal

1. **Split `sevenshell-web` into lib + bin.** Router, handlers and submodules move to a lib with an
   injected surface: `serve(core, vault, static_dir, port, token, shutdown)` plus a browser-session
   counter hook (WS open/close) so an owner can stop when the last browser session leaves. The bin
   becomes a thin CLI wrapper; its flags, env vars and output stay byte-identical.
2. **New `src-tauri` host module.** On-demand start/stop; ephemeral port; run-scoped random token;
   URL `http://127.0.0.1:<port>/#token=<t>&open=desktop:<session_id>`; stops when the last browser
   WS session disconnects and on app exit. Zero listeners while idle.
3. **One Tauri command** `desktop_browser_open(session_id)`: start-or-reuse the host, build the URL,
   open the system default browser via the existing `reveal.rs::open_url` (`reveal.rs:101`).

**What does not change:** the endpoint set (the lib carries today's contract as-is), the token
story in shape (one random token, everything without it refused), `sshell-web` the standalone bin
(unchanged, keeps its own vault for headless use), the app's default behaviour (the feature exists
only behind the explicit open action), and the loopback-only promise (no LAN listen, ever).

## Alternatives considered

- **Sidecar `sshell-web` process:** the bin owns a separate vault and settings; "hand this
  connection over" becomes "re-create it elsewhere". Rejected on product grounds.
- **Do nothing (polish standalone only):** leaves the user's ask — open *this* desktop in a
  browser from *this* app — unimplemented.
- **Frontend-only tricks (WebView2 remote debugging as a bridge):** not a product surface, unsafe,
  unreviewable. Rejected.

## Impact

| Area | Effect |
|---|---|
| Security invariants | Loopback-only + token-gated inherited from `sshell-web` and the MCP server (cite `mcp/server.rs` auth helpers; constant-time compare). New facts, all risk-reducing: default off, on-demand start, auto-stop after the last browser session. URL carries the token in the **fragment** (`#token=…`), not the query, so it never lands in server-side logs or history query strings; per-call auth uses the header, WS handshake keeps the existing query channel. |
| Wire format / contracts | No endpoint changes. New lib API is internal to the workspace. Frontend reads the fragment token in the phase-seven frontend lane (BR-S); until then the browser story of *this* PIP is backend-only. |
| Tests | Bin behaviour regression (existing crate tests, byte-identical CLI), oneshot router tests along the MCP precedent, no-token refusal, idle-stop, URL shape, zero-listener-while-idle. |
| Migration | None: no data is written by the feature; per-origin localStorage memory stays as documented (app and browser keep separate memories by design, not synced). |
| Dependencies | `tower-http` joins `src-tauri` (workspace version already used by `sevenshell-web`); axum is already there. No new dependency class. |

**Static assets in the packaged app (decision D9):** the release build must serve the interface to
a real browser, and Tauri's custom protocol does not resolve outside the webview. The dist folder
ships as a **Tauri bundle resource** (`bundle.resources` in `tauri.conf.json`) and the host serves
`resource_dir()`; in dev the host falls back to `apps/desktop/dist`. Verified again at the NSIS
step of the phase-seven closeout.

## Open questions

None blocking. Frontend-scope items (fragment reading, stub tab, deep-link routing) are chartered
in the phase-seven plan and deliberately out of this PIP.
