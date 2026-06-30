# signalk-navico-embedder

A SignalK plugin that presents your installed Signal K web apps as webapp tiles on B&G/Navico marine MFDs (Zeus, Vulcan, etc.). It handles the UDP multicast announcement protocol the MFD expects, and works around the significant browser limitations of the MFD's embedded Chromium.

## What it does

1. Runs an HTTP reverse proxy that forwards requests to the local Signal K server
2. Broadcasts UDP multicast announcements that tell the MFD to show a tile for each selected web app
3. Patches the proxied HTML and JS to be compatible with the MFD's old Chromium browser

The embedded configurator can **auto-detect installed Signal K webapps**, so you just click _Discover_ and enable the ones you want on the MFD.

## Installation

Install through the SignalK AppStore, or manually:

```bash
cd ~/.signalk
npm install signalk-navico-embedder
```

Then restart the SignalK server and enable the plugin in **Server → Plugin Config**.

## Configuration

Open **Server → Plugin Config → Navico MFD Embedder**. The plugin ships an embedded
configurator that replaces the generic settings form:

1. **MFD display mode** — choose how apps appear on the MFD:
   - **Individual Apps** (default) — announce every enabled app below as its own tile on the MFD.
   - **Launcher** — announce a single tile that opens the [app-chooser webapp](#app-chooser-webapp), from which all enabled apps can be launched. Keeps the MFD's tile list uncluttered when you have many apps.
2. **Local IP address override** — leave blank to auto-detect. Set this if the machine has multiple network interfaces and the wrong one is selected.
3. **Proxy port** — the HTTP port this proxy listens on (default: `8080`).
4. **Signal K authentication token** — see [Authentication](#authentication) below.
5. **Discover Installed Webapps** — scans the Signal K server for installed web apps and adds any new ones to the list below.
6. **MFD Apps** — the apps that become tiles on the MFD. For each entry you can:
   - drag to reorder,
   - edit the **name**, **description**, and **icon** shown on the tile,
   - toggle **enabled** (disabled apps are kept in the list but not announced),
   - **remove** it entirely.

Click **Save Configuration** to apply; the plugin restarts and re-announces the
enabled tiles.

In **Individual Apps** mode every enabled app is announced to the MFD as
`http://<ip>:<port><app-path>`, and the proxy forwards that path to the local Signal K
server. In **Launcher** mode a single tile pointing at `/signalk-navico-embedder/` is
announced instead; the enabled-app list still drives what that page shows.

## App-chooser webapp

The plugin also ships a standalone web app at **`/signalk-navico-embedder/`** that shows
every enabled app in a grid of icon + title tiles. Tap a tile to open that app. The page
also renders a **debug panel** (user agent, query-string parameters the MFD appends,
window/screen size, etc.) which is handy when diagnosing the MFD's browser.

It works for both logged-in and unauthenticated users. On plugin startup the enabled-app
list is published to the data model at `plugins.signalk-navico-embedder.webapps`, which the
page reads from:

```
GET /signalk/v1/api/vessels/self/plugins/signalk-navico-embedder/webapps
```

Each entry contains `name`, `url`, and `icon`. URLs are server-relative, so the same page
works whether it is opened directly on the Signal K server or through the proxy on the MFD.
Unauthenticated access to the list requires **Allow Read-Only Access** (or, on the MFD, the
token the proxy injects — see [Authentication](#authentication)).

## Authentication

The MFD has no Signal K session cookie, so when Signal K has **authentication enabled** and **Allow Read-Only Access** disabled, all API and WebSocket requests from the MFD return 401 and no data is displayed — even though the WebSocket upgrade itself may appear to succeed.

There are two ways to fix this:

### Option A — Enable read-only access (simpler)

In Signal K admin go to **Security** and toggle **Allow Read-Only Access**. This permits unauthenticated devices to read vessel data without being able to write. Appropriate for a private boat LAN.

### Option B — Inject a JWT token (more secure)

1. In Signal K admin go to **Security → Token Management** (or use `POST /signalk/v1/auth/login`) to generate a token for the MFD.
2. Paste the JWT into **Plugin Config → Navico MFD Embedder → Signal K authentication token**.
3. Save and restart the plugin.

When a token is configured the proxy:

- Adds `Authorization: Bearer <token>` to every forwarded HTTP request
- Appends `?token=<token>` to every WebSocket upgrade URL
- Injects `window.SK_TOKEN = "<token>"` into every HTML response so the webapp JS can authenticate its own fetch and WebSocket calls independently

This means the token only needs to be stored once (in the plugin config) and works transparently for all proxied apps.

## How the B&G/Navico MFD webapp tile protocol works

Discovered by reverse-engineering [signalk-mfd-plugin](https://github.com/htool/signalk-mfd-plugin).

The MFD listens for **UDP multicast packets** on:

- **Multicast group:** `239.2.1.1`
- **Port:** `2053`

Every 10 seconds this plugin sends a JSON payload to that group advertising the proxy URL. The MFD opens that URL in its browser panel when the tile is tapped.

Key rules:

- The **`IP` field must exactly match the source IP the UDP socket is bound to**. The MFD validates this.
- The MFD must be connected via **wired Ethernet** (not Wi-Fi) to receive these announcements.

The MFD also appends query parameters to the URL when launching the tile, e.g.:

```
?mfd_name=NavStation&mfd_model_detail=Zeus3S%2012&lang=en&mode=day&brand=B%26G
```

## Why a proxy instead of pointing directly at the target

Several issues prevent the MFD from loading web apps directly from another host:

### 1. Conditional request headers cause 304s with no cached content

The MFD browser sends `If-None-Match` / `If-Modified-Since` headers (stale ETags cached from a different origin). The target server correctly responds 304 Not Modified, but the MFD has no cached content for that origin — so it gets a 304 with no body and renders nothing.

**Fix:** Strip all conditional request headers before forwarding to the target.

### 2. X-Frame-Options / CSP block iframe embedding

An iframe-based approach doesn't work because targets typically set `X-Frame-Options` or `Content-Security-Policy` headers.

**Fix:** Use a transparent reverse proxy. The MFD browser renders the target content directly.

### 3. Gzip responses break HTML injection

If the target gzip-compresses HTML, string replacements corrupt the data.

**Fix:** Strip `Accept-Encoding` so the server always returns uncompressed responses.

## MFD browser limitations (Zeus3S 12 / NavStation)

The B&G Zeus3S 12 runs an **embedded Chromium somewhere in the Chrome 60–72 range**. This plugin fixes two categories of issues:

### Syntax issues — fixed with esbuild transpilation

Modern JavaScript build tools output ES2020+ syntax. The MFD's Chromium doesn't support optional chaining (`?.`) or nullish coalescing (`??`). All `application/javascript` responses are transpiled to `chrome70` target via esbuild.

### Missing runtime APIs — fixed with injected polyfills

These APIs are polyfilled by injecting a `<script>` into every HTML response:

| API                                | Minimum Chrome |
| ---------------------------------- | -------------- |
| `Object.fromEntries`               | 73             |
| `Array.prototype.flat` / `flatMap` | 69             |
| `Array.prototype.at`               | 92             |
| `String.prototype.at`              | 92             |
| `String.prototype.replaceAll`      | 85             |
| `Object.hasOwn`                    | 93             |
| `Promise.allSettled`               | 76             |
| `globalThis`                       | 71             |
| `queueMicrotask`                   | 71             |

## Proxy behaviour summary

| Request/Response                      | What the proxy does                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Conditional cache headers in request  | Stripped — prevents spurious 304s                                                        |
| `Accept-Encoding` in request          | Stripped — ensures uncompressed responses                                                |
| `X-Frame-Options` in response         | Stripped                                                                                 |
| `Content-Security-Policy` in response | Stripped                                                                                 |
| `Location` redirect headers           | Rewritten from target origin to proxy origin                                             |
| HTML responses                        | Polyfill `<script>` injected before `</head>`; `window.SK_TOKEN` set if token configured |
| JavaScript responses                  | Transpiled via esbuild to `chrome70` target                                              |
| WebSocket upgrades                    | Forwarded to target; `Authorization` header and `?token=` appended if token configured   |
| All HTTP requests (if token set)      | `Authorization: Bearer <token>` header added                                             |

## Development

The embedded configurator is a React 19 component in [`src/configpanel/`](src/configpanel/),
exposed to the Signal K admin UI via Webpack Module Federation. After editing it, rebuild
the bundle into `public/` (which is auto-mounted and shipped with the package):

```bash
npm run build:config
```

The backend plugin ([`index.js`](index.js)) is plain CommonJS and needs no build step.
`npm run prepublishOnly` rebuilds the configurator automatically before publishing.

### Tests

The plugin has a test suite built on Node's built-in test runner (no extra
dependencies). It covers the config-to-announcement transforms and the proxy's
runtime behaviour — header rewriting, HTML/token injection, JS transpilation,
the fallback-icon route, and the start/stop lifecycle (UDP is stubbed, so no
multicast traffic is emitted):

```bash
npm test          # run once
npm run test:watch # re-run on change
```

## Reference

- [signalk-mfd-plugin](https://github.com/htool/signalk-mfd-plugin) — source of the UDP multicast protocol details
- [hoekens-anchor-alarm](https://github.com/hoeken/hoekens-anchor-alarm) — a Vite/Svelte SignalK webapp; the app this proxy was originally developed against
