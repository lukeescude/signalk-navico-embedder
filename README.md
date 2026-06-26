# signalk-navico-embedder

A SignalK plugin that presents any web app as a webapp tile on B&G/Navico marine MFDs (Zeus, Vulcan, etc.). It handles the UDP multicast announcement protocol the MFD expects, and works around the significant browser limitations of the MFD's embedded Chromium.

## What it does

1. Runs an HTTP reverse proxy that forwards requests to a configurable target URL
2. Broadcasts UDP multicast announcements that tell the MFD to show a tile for the proxy URL
3. Patches the proxied HTML and JS to be compatible with the MFD's old Chromium browser

## Installation

Install through the SignalK AppStore, or manually:

```bash
cd ~/.signalk
npm install signalk-navico-embedder
```

Then restart the SignalK server and enable the plugin in **Server → Plugin Config**.

## Configuration

| Field             | Required | Description                                                                     |
| ----------------- | -------- | ------------------------------------------------------------------------------- |
| Target URL        | Yes      | Full URL of the web app to proxy (e.g. `http://localhost:3000/app/`)            |
| Proxy port        | Yes      | HTTP port this proxy listens on (default: `8080`)                               |
| Tile name         | No       | Name shown on the MFD tile                                                      |
| Tile description  | No       | Description shown on the MFD tile                                               |
| Local IP override | No       | Leave blank to auto-detect. Set if the machine has multiple network interfaces. |

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

| Request/Response                      | What the proxy does                           |
| ------------------------------------- | --------------------------------------------- |
| Conditional cache headers in request  | Stripped — prevents spurious 304s             |
| `Accept-Encoding` in request          | Stripped — ensures uncompressed responses     |
| `X-Frame-Options` in response         | Stripped                                      |
| `Content-Security-Policy` in response | Stripped                                      |
| `Location` redirect headers           | Rewritten from target origin to proxy origin  |
| HTML responses                        | Polyfill `<script>` injected before `</head>` |
| JavaScript responses                  | Transpiled via esbuild to `chrome70` target   |
| WebSocket upgrades                    | Forwarded transparently to target             |

## Reference

- [signalk-mfd-plugin](https://github.com/htool/signalk-mfd-plugin) — source of the UDP multicast protocol details
- [hoekens-anchor-alarm](https://github.com/hoeken/hoekens-anchor-alarm) — a Vite/Svelte SignalK webapp; the app this proxy was originally developed against
