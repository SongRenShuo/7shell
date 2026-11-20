# The interface, shipped for the browser

The browser host serves the built interface over loopback, and a packaged application has no
`apps/desktop/dist` on disk — Tauri compiles the frontend into the binary, where nothing outside
the webview can read it. So the built interface is shipped a second time as a bundle resource, in
this folder, and `scripts/prepare-desktop-resources.mjs` is what puts it here (it runs from
`beforeBuildCommand`).

This file is the placeholder that keeps the resource glob matching on a clean checkout, so
`cargo check` and `cargo test` do not need a built interface to pass. The real build replaces the
copied files around it; a package that somehow shipped only this file would answer the host's
search with "no static directory" rather than serve something wrong, because the host looks for
`index.html`.
