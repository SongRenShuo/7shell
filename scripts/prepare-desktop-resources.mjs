#!/usr/bin/env node
// Copies the built interface into the application's bundle resources.
//
// The browser host serves real files over HTTP, and a packaged application has no `apps/desktop/dist`
// on disk: Tauri compiles the frontend into the binary's assets, where nothing outside the webview
// can read it. So the built interface is shipped twice — once inside the binary for the window, once
// as a resource for the browser — and this script is what puts the second copy where the host looks.
//
// It runs from `beforeBuildCommand`, before the bundle is assembled; `resources/dist` is what
// `tauri.conf.json` declares. A missing `dist` is an error rather than a warning: a package that
// silently cannot hand its desktop to a browser is exactly the failure this script exists to stop.

import { cp, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";

import { REPO_ROOT } from "./lib/descriptors.mjs";

const SOURCE = path.join(REPO_ROOT, "apps", "desktop", "dist");
const TARGET = path.join(REPO_ROOT, "src-tauri", "resources", "desktop");

const built = await stat(path.join(SOURCE, "index.html")).catch(() => null);
if (!built?.isFile()) {
  console.error(`build:desktop-resources: ${SOURCE} holds no index.html — build the interface first`);
  process.exit(1);
}

// The folder is rebuilt rather than merged: a file the last build left behind would be served to a
// browser as if it were current. The placeholder README is the one thing kept — it is what the
// resource glob matches on a clean checkout, and deleting a tracked file would turn a build into a
// dirty working tree.
for (const entry of await readdir(TARGET).catch(() => [])) {
  if (entry !== "README.md") {
    await rm(path.join(TARGET, entry), { recursive: true, force: true });
  }
}
await cp(SOURCE, TARGET, { recursive: true });
console.log(`build:desktop-resources: ${path.relative(REPO_ROOT, SOURCE)} -> ${path.relative(REPO_ROOT, TARGET)}`);
