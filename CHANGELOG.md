# v1.3.0

- New **MFD display mode** plugin option: choose **Individual Apps** (default — announce every enabled web app as its own MFD tile, as before) or **Launcher** (announce a single tile that opens the app-chooser page, from which all enabled apps are launched)
- Standalone app-chooser webapp at `/signalk-navico-embedder/`: shows every enabled web app in a grid of icon + title tiles, accessible to both logged-in and unauthenticated users
- Publishes the enabled-app list (name, url, icon) as a delta to `plugins.signalk-navico-embedder.webapps` on startup, readable without authentication via `GET /signalk/v1/api/vessels/self/plugins/signalk-navico-embedder/webapps`
- The chooser page shows debug information (user agent, query string and parsed params, window/screen size, etc.) to aid MFD troubleshooting

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
