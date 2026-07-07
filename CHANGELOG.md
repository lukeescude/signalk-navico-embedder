# v1.4.1 (2026-07-06)

- Corrected the MFD's documented and targeted Chromium version from 70 to **69** (its actual, verified version): the esbuild transpilation target changed `chrome70` → `chrome69` and the `postcss-preset-env` browserslist target changed `Chrome >= 70` → `Chrome >= 69`. Both changes only make downleveling more conservative, so nothing that worked before regresses; confirmed against the full test suite
- Split the developer-facing material out of README.md into a new [CONTRIBUTING.md](CONTRIBUTING.md) — the MFD announcement protocol, the proxy rationale, the Chromium compatibility fixes, the proxy behavior summary table, and the build/dev/test workflow — leaving README focused on installation and configuration for end users
- Added release dates to every CHANGELOG.md version heading
- Fixed the npm publish workflow's release-notes extraction, which required an exact `# vX.Y.Z` heading match and would otherwise have broken once dates were added to headings; it now matches on the version prefix

# v1.4.0 (2026-07-04)

- **In-panel authentication token generation**: the config panel now has a dedicated "Signal K auth token" field and a **Generate Authentication Token** button that runs Signal K's device access-request flow and shows the live approval status, so a token can be created and stored entirely from the plugin UI. Previously `skToken` was declared in the schema and documented in the README, but the React panel (which replaces Signal K's auto-generated form) rendered no input for it — it only preserved an already-set value, leaving no way to enter one through the UI
- Added a **permission-level selector** (Read / Read-Write / Admin) that feeds the access request's `permissions` field instead of hard-coding `readwrite`; the level selector and generate button hide once a token is present, while the approval status message stays visible (fixes #5)
- Config panel now **auto-discovers installed web apps when it opens** (with a spinner) instead of requiring a manual "Discover Installed Webapps" click; newly discovered apps start **disabled** so they are opted in explicitly, the per-app "Remove" button was dropped, and the enabled toggle is now an inline "Enabled" checkbox
- Fixed the **SignalK Admin** discovery entry: it now announces as "SignalK Admin" with the bundled Signal K logo icon and a description, instead of an unlabeled "Settings" tile with no icon
- Config-panel layout polish: token/select fields use the full column width with the note stacked below, port (number) fields stay narrow with the note inline, and the generate button spans the input/note columns
- Schema/docs sync: declared `icon` under `apps.items` so the schema matches what `buildAppModel` and Discover actually use, and documented the "Signal K server port" and auth-token options in the README
- Removed the redundant IP address from the MFD announcement status message (it duplicated the server URL already shown)
- Documentation: expanded the verified-hardware list (added B&G Zeus³ 12", fixes #4), added Signal K Admin and R&D/testing notes, refreshed the app screenshots (instrument panel, SailSense, tides, anchor alarm, launcher, home screen), and tightened the package description

# v1.3.1 (2026-07-01)

- Fixed intermittent WebSocket data loss through the proxy: when the upstream Signal K server's `101 Switching Protocols` handshake and its first WS frame (e.g. the connection `hello`) arrived in the same TCP read, Node's `http` client split them into the `upgrade` event's response and a separate `head` buffer that the proxy was silently discarding. This showed up as instrumentpanel (and other apps using the delta stream) intermittently never receiving their initial state on load, causing visible flashing/flicker on the MFD. Both the client- and upstream-facing `upgrade` handlers now forward that `head` buffer before piping
- JavaScript transpilation now minifies (`esbuild` `minify: true`), fixing a regression where the unminified transpiled output was ~46% larger than the original bundle, adding unnecessary parse/download weight on every page load
- New CSS downlevel pipeline (`postcss` + `postcss-preset-env`, targeting Chrome 70): apps built with current tooling (e.g. Tailwind v4) emit CSS using cascade layers (`@layer`), `oklch()`/`color-mix()` colors, and `:is()`, none of which the MFD's embedded Chromium understands. Unrecognized at-rules like `@layer` are dropped wholesale by old browsers, which was silently deleting apps' reset/base styles — seen as huge default-UA-styled headings and near-invisible text color on the MFD despite the same page looking correct in a modern browser
- Added a small custom PostCSS plugin to fall back CSS `min()`/`max()` value functions (unsupported before Chrome 79, and not statically resolvable by `postcss-preset-env` since the result depends on the runtime viewport) to their first argument — matching the common `min(<viewport-relative>, <fixed cap>)` convention, this preserves "don't overflow a small screen" behavior on the MFD at the cost of the upper/lower cap on larger screens. Fixes a collapsed/single-column dialog layout (e.g. a station-picker map dialog) whose explicit width was silently dropped
- Diagnosed all three fixes above against a real Chrome 70.0.3538.0 binary (matching the MFD's embedded Chromium) driven directly over the DevTools protocol, rather than guessing from a modern browser

# v1.3.0 (2026-06-30)

- New **MFD display mode** plugin option: choose **Individual Apps** (default — announce every enabled web app as its own MFD tile, as before) or **Launcher** (announce a single tile that opens the app-chooser page, from which all enabled apps are launched)
- Standalone app-chooser webapp at `/signalk-navico-embedder/`: lists every enabled web app, accessible to both logged-in and unauthenticated users
- Redesigned the chooser tiles as horizontal rows — a large (96px) rounded icon on the left with the app name and description stacked on the right; the whole row is a single clickable link, descriptions clamp to four lines, and the problematic `title`/`alt` attributes were dropped for the MFD
- New per-app **description** field in the configuration panel, shown on the chooser tiles
- Light/dark theming for the chooser: all colors moved into CSS variables, with an inline head script that selects the palette before first paint — `?mode=night` forces dark, `?mode=day` forces light, and with no `mode` param it follows the browser's `prefers-color-scheme` (defaulting to dark)
- The chooser forwards its own query string verbatim to every webapp link (e.g. `?mode=day` and other MFD params reach the embedded apps), merging with `&` when the target URL already has a query and keeping the query ahead of any `#` fragment
- Hardened the chooser for kiosk touchscreen use: viewport locked against pinch/double-tap zoom, `touch-action: manipulation`, no tap highlight / text selection / iOS touch-callout / overscroll bounce / text auto-inflation, and the long-press context menu is suppressed in JS
- Publishes the enabled-app list (name, url, icon) as a delta to `plugins.signalk-navico-embedder.webapps` on startup, readable without authentication via `GET /signalk/v1/api/vessels/self/plugins/signalk-navico-embedder/webapps`
- The chooser page shows debug information (user agent, query string and parsed params, window/screen size, etc.) to aid MFD troubleshooting
- Added a test suite using Node's built-in test runner (no new dependencies) wired up via `npm test`; the config-to-announcement transforms were lifted out of the `start()` closure into testable module-level helpers (`getServerPort`, `buildAnnouncement`, `buildAppModel`) with no behavior change. Covers port resolution, announcement/tile/webapp model building, launcher vs individual mode, and the running proxy (header stripping, HTML/token injection, esbuild transpilation, fallback-icon route, `Location` rewriting, 502 handling, and start/stop lifecycle with UDP stubbed)
- Packaging fix: restored the bundled `icon.png`/`icon.ico` fallback icons and re-added them to the `files` array so they ship in the npm package and `FALLBACK_ICON` resolves at runtime for installed users

# v1.2.2 (2026-06-30)

- WebSocket proxy reliability: disable Nagle (`setNoDelay(true)`) on both the MFD and upstream sockets so small WS frames are not buffered
- Added a 10-second upgrade-handshake timeout — if the upstream does not complete the WS handshake in time, both sockets are destroyed; the timer is cancelled on success or error so it never kills an established tunnel
- Abort in-progress upgrades when the MFD socket closes or errors before the handshake completes
- Reject non-101 upgrade responses (e.g. SK auth failures) instead of tunnelling them as if they were a WebSocket stream
- Cross-link `close` events on both tunnel sockets so either side tearing down immediately cleans up the other
- Improved debug logging for WS tunnel lifecycle and upstream errors

# v1.2.1 (2026-06-29)

- Upgraded esbuild from 0.24.x to 0.28.1 (resolves GHSA-67mh-4wv8-2f99; only the dev server API was affected, not the `transform` usage in this plugin)
- Added `screenshots/` directory with `screenshot_home.png`; wired it into `package.json` (`signalk.screenshots`) for the SignalK AppStore and into `files` for npm packaging
- README: added screenshot
- Proper icon/logo management for SignalK apps

# v1.2.0 (2026-06-29)

- Signal K authentication token support: new `skToken` plugin config field accepts a JWT
- When a token is set, injects `Authorization: Bearer <token>` into all forwarded HTTP requests
- When a token is set, appends `?token=<token>` to WebSocket upgrade URLs (Signal K accepts this form)
- When a token is set, injects `window.SK_TOKEN = "<token>"` into every HTML response so webapp JS can authenticate its own fetch/WebSocket calls independently
- README: added Authentication section documenting Option A (read-only access) and Option B (token injection), and updated the proxy behavior summary table

# v1.1.0 (2026-06-28)

- Multi-app / multi-tile MFD announcements: replaced single-URL config with an `apps` array so multiple web apps can be announced as separate tiles on the MFD simultaneously
- React configuration panel with a "Discover Installed Webapps" button that auto-detects installed Signal K web apps and populates the app list
- Auto-proxy to the local Signal K server with automatic port detection (reads `PORT` env var, then `app.config.settings.port`, then defaults to `3000`); explicit `serverPort` override available in config
- Per-app icon support; falls back to the bundled plugin icon served via `/__navico-embedder-icon` when no app-specific icon is provided
- Webpack build for the React config panel, output to `public/index.html`
- ESLint + Prettier code style enforcement with husky/lint-staged pre-commit hook
- GitHub Actions workflows for Signal K CI testing and automated npm publishing
- Added `RELEASE.md` documenting the release process

# v1.0.0 (2026-06-28)

- Initial release as a SignalK plugin
- HTTP reverse proxy that forwards requests to a configurable target URL
- UDP multicast announcements to B&G/Navico MFDs (group 239.2.1.1, port 2053)
- Automatic IP detection with optional manual override
- HTML polyfill injection for MFD's older embedded Chromium (< Chrome 73)
- JavaScript transpilation to Chrome 70 target via esbuild
- WebSocket upgrade forwarding
