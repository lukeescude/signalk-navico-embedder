# v1.3.0

- New **MFD display mode** plugin option: choose **Individual Apps** (default — announce every enabled web app as its own MFD tile, as before) or **Launcher** (announce a single tile that opens the app-chooser page, from which all enabled apps are launched)
- Standalone app-chooser webapp at `/signalk-navico-embedder/`: lists every enabled web app, accessible to both logged-in and unauthenticated users
- Redesigned the chooser tiles as horizontal rows — a large (96px) rounded icon on the left with the app name and description stacked on the right; the whole row is a single clickable link, descriptions clamp to four lines, and the problematic `title`/`alt` attributes were dropped for the MFD
- New per-app **description** field in the configuration panel, shown on the chooser tiles
- Light/dark theming for the chooser: all colors moved into CSS variables, with an inline head script that selects the palette before first paint — `?mode=night` forces dark, `?mode=day` forces light, and with no `mode` param it follows the browser's `prefers-color-scheme` (defaulting to dark)
- The chooser forwards its own query string verbatim to every webapp link (e.g. `?mode=day` and other MFD params reach the embedded apps), merging with `&` when the target URL already has a query and keeping the query ahead of any `#` fragment
- Hardened the chooser for kiosk touchscreen use: viewport locked against pinch/double-tap zoom, `touch-action: manipulation`, no tap highlight / text selection / iOS touch-callout / overscroll bounce / text auto-inflation, and the long-press context menu is suppressed in JS
- Publishes the enabled-app list (name, url, icon) as a delta to `plugins.signalk-navico-embedder.webapps` on startup, readable without authentication via `GET /signalk/v1/api/vessels/self/plugins/signalk-navico-embedder/webapps`
- The chooser page shows debug information (user agent, query string and parsed params, window/screen size, etc.) to aid MFD troubleshooting
- Added a test suite using Node's built-in test runner (no new dependencies) wired up via `npm test`; the config-to-announcement transforms were lifted out of the `start()` closure into testable module-level helpers (`getServerPort`, `buildAnnouncement`, `buildAppModel`) with no behaviour change. Covers port resolution, announcement/tile/webapp model building, launcher vs individual mode, and the running proxy (header stripping, HTML/token injection, esbuild transpilation, fallback-icon route, `Location` rewriting, 502 handling, and start/stop lifecycle with UDP stubbed)
- Packaging fix: restored the bundled `icon.png`/`icon.ico` fallback icons and re-added them to the `files` array so they ship in the npm package and `FALLBACK_ICON` resolves at runtime for installed users

# v1.2.2

- WebSocket proxy reliability: disable Nagle (`setNoDelay(true)`) on both the MFD and upstream sockets so small WS frames are not buffered
- Added a 10-second upgrade-handshake timeout — if the upstream does not complete the WS handshake in time, both sockets are destroyed; the timer is cancelled on success or error so it never kills an established tunnel
- Abort in-progress upgrades when the MFD socket closes or errors before the handshake completes
- Reject non-101 upgrade responses (e.g. SK auth failures) instead of tunnelling them as if they were a WebSocket stream
- Cross-link `close` events on both tunnel sockets so either side tearing down immediately cleans up the other
- Improved debug logging for WS tunnel lifecycle and upstream errors

# v1.2.1

- Upgraded esbuild from 0.24.x to 0.28.1 (resolves GHSA-67mh-4wv8-2f99; only the dev server API was affected, not the `transform` usage in this plugin)
- Added `screenshots/` directory with `screenshot_home.png`; wired it into `package.json` (`signalk.screenshots`) for the SignalK AppStore and into `files` for npm packaging
- README: added screenshot
- Proper icon/logo management for SignalK apps

# v1.2.0

- Signal K authentication token support: new `skToken` plugin config field accepts a JWT
- When a token is set, injects `Authorization: Bearer <token>` into all forwarded HTTP requests
- When a token is set, appends `?token=<token>` to WebSocket upgrade URLs (Signal K accepts this form)
- When a token is set, injects `window.SK_TOKEN = "<token>"` into every HTML response so webapp JS can authenticate its own fetch/WebSocket calls independently
- README: added Authentication section documenting Option A (read-only access) and Option B (token injection), and updated the proxy behaviour summary table

# v1.1.0

- Multi-app / multi-tile MFD announcements: replaced single-URL config with an `apps` array so multiple web apps can be announced as separate tiles on the MFD simultaneously
- React configuration panel with a "Discover Installed Webapps" button that auto-detects installed Signal K web apps and populates the app list
- Auto-proxy to the local Signal K server with automatic port detection (reads `PORT` env var, then `app.config.settings.port`, then defaults to `3000`); explicit `serverPort` override available in config
- Per-app icon support; falls back to the bundled plugin icon served via `/__navico-embedder-icon` when no app-specific icon is provided
- Webpack build for the React config panel, output to `public/index.html`
- ESLint + Prettier code style enforcement with husky/lint-staged pre-commit hook
- GitHub Actions workflows for Signal K CI testing and automated npm publishing
- Added `RELEASE.md` documenting the release process

# v1.0.0

- Initial release as a SignalK plugin
- HTTP reverse proxy that forwards requests to a configurable target URL
- UDP multicast announcements to B&G/Navico MFDs (group 239.2.1.1, port 2053)
- Automatic IP detection with optional manual override
- HTML polyfill injection for MFD's older embedded Chromium (< Chrome 73)
- JavaScript transpilation to Chrome 70 target via esbuild
- WebSocket upgrade forwarding
