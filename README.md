# mfd-embedder

A Node.js proxy that presents any web app as a webapp tile on B&G/Navico marine MFDs (Zeus, Vulcan, etc.). It handles the UDP multicast announcement protocol the MFD expects, and works around the significant browser limitations of the MFD's embedded Chromium.

Please note this project is quite opinionated towards Hoeken's Anchor Alarm, and may not work with other web apps. I will try to eventually get around to designing this as a full cross-compatible proxy/embedder installable in SignalK.

## What it does

1. Runs an HTTP reverse proxy that forwards requests to a target URL (e.g. a SignalK plugin's UI)
2. Broadcasts UDP multicast announcements that tell the MFD to show a tile for the proxy URL
3. Patches the proxied HTML and JS to be compatible with the MFD's old Chromium browser

## Configuration

Edit `config.json`:

```json
{
  "ip": "192.168.50.37",
  "port": 8080,
  "targetUrl": "http://192.168.50.238:3000/hoekens-anchor-alarm/",
  "tile": {
    "source": "mfd-embedder",
    "featureName": "Anchor Alarm",
    "name": "Anchor Alarm",
    "description": "Hoeken's Anchor Alarm"
  }
}
```

- `ip` — The IP address of **this machine** on the local network. Must be a real interface IP; the MFD connects back to this address. This is also the source IP the UDP socket binds to.
- `port` — The HTTP port this proxy listens on.
- `targetUrl` — The full URL of the web app to proxy. The path is preserved in the tile URL announced to the MFD.
- `tile` — Display metadata shown on the MFD tile.

## Running

```bash
npm install
node index.js
```

## How the B&G/Navico MFD webapp tile protocol works

Discovered by reverse-engineering [signalk-mfd-plugin](https://github.com/htool/signalk-mfd-plugin).

The MFD listens for **UDP multicast packets** on:
- **Multicast group:** `239.2.1.1`
- **Port:** `2053`

Every 10 seconds this proxy sends a JSON payload to that group:

```json
{
  "Version": "1",
  "Source": "mfd-embedder",
  "IP": "192.168.50.37",
  "FeatureName": "Anchor Alarm",
  "Text": [{ "Language": "en", "Name": "Anchor Alarm", "Description": "..." }],
  "Icon": "http://192.168.50.37:8080/hoekens-anchor-alarm/",
  "URL": "http://192.168.50.37:8080/hoekens-anchor-alarm/",
  "OnlyShowOnClientIP": "true",
  "BrowserPanel": {
    "Enable": true,
    "ProgressBarEnable": true,
    "MenuText": [{ "Language": "en", "Name": "Anchor Alarm" }]
  }
}
```

Key rules:
- The **`IP` field must exactly match the source IP the UDP socket is bound to**. The MFD validates this. If they don't match, the tile won't appear.
- The MFD must be connected via **wired Ethernet** (not Wi-Fi) to receive these announcements.
- The `URL` field is what the MFD opens in its browser panel when the tile is tapped.

The MFD also appends query parameters to the URL when launching the tile, e.g.:
```
?mfd_name=NavStation&mfd_model_detail=Zeus3S%2012&lang=en&mode=day&brand=B%26G
```

## Why a proxy instead of pointing directly at the target

Several issues prevent the MFD from loading web apps directly from another host:

### 1. Conditional request headers cause 304s with no cached content

The MFD browser sends `If-None-Match` / `If-Modified-Since` headers (stale ETags cached from a different origin). The target server correctly responds 304 Not Modified, but the MFD has no cached content for that origin — so it gets a 304 with no body and renders nothing.

**Fix:** Strip all conditional request headers (`If-None-Match`, `If-Modified-Since`, `If-Match`, `If-Unmodified-Since`, `If-Range`) before forwarding to the target.

### 2. X-Frame-Options / CSP block iframe embedding

An iframe-based approach (serving a page that iframes the target) doesn't work because the target sets `X-Frame-Options` or `Content-Security-Policy` headers.

**Fix:** Use a transparent reverse proxy instead of an iframe. The MFD browser renders the target content directly.

### 3. Gzip responses break HTML injection

The target server gzip-compresses HTML responses. If you buffer gzip bytes and try to do a string replacement, you corrupt the data.

**Fix:** Strip `Accept-Encoding` from all proxied requests so the server always returns uncompressed responses.

## MFD browser limitations (Zeus3S 12 / NavStation)

The B&G Zeus3S 12 runs an **embedded Chromium somewhere in the Chrome 60–72 range** (confirmed below Chrome 73). This is significantly behind modern web standards.

### Syntax issues — fixed with esbuild transpilation

Modern JavaScript build tools (Vite, Rollup) output ES2020+ syntax by default. The MFD's Chromium doesn't support:

| Feature | Minimum Chrome |
|---|---|
| Optional chaining (`?.`) | 80 |
| Nullish coalescing (`??`) | 80 |

**Fix:** Intercept all `application/javascript` responses and run them through esbuild targeting `chrome70`. This rewrites modern syntax to equivalent ES5/ES6 without changing behaviour.

```
Error observed: Uncaught SyntaxError: Unexpected token ? @ assets/index.js:145
```

### Missing runtime APIs — fixed with injected polyfills

These are APIs (not syntax), so esbuild cannot handle them. They are polyfilled by injecting a `<script>` into every HTML response before `</head>`:

| API | Minimum Chrome |
|---|---|
| `Object.fromEntries` | 73 |
| `Array.prototype.flat` | 69 |
| `Array.prototype.flatMap` | 69 |
| `Array.prototype.at` | 92 |
| `String.prototype.at` | 92 |
| `String.prototype.replaceAll` | 85 |
| `Object.hasOwn` | 93 |
| `Promise.allSettled` | 76 |
| `globalThis` | 71 |
| `queueMicrotask` | 71 |

```
Error observed: Uncaught TypeError: Object.fromEntries is not a function @ assets/index.js:27382
```

### WebSocket support

WebSocket itself is supported. The app (Hoeken's Anchor Alarm) uses `window.location.hostname` and `window.location.port` to construct its WebSocket URL, so it correctly connects through the proxy. The proxy forwards WebSocket upgrade requests to the target.

### `<script type="module">` support

ES modules **are** supported (the MFD requests module scripts). The issue is purely the syntax and APIs inside those modules, not the module loading mechanism itself.

## Proxy behaviour summary

| Request/Response | What the proxy does |
|---|---|
| Conditional cache headers in request | Stripped — prevents spurious 304s |
| `Accept-Encoding` in request | Stripped — ensures uncompressed responses we can modify |
| `X-Frame-Options` in response | Stripped |
| `Content-Security-Policy` in response | Stripped |
| `Location` redirect headers | Rewritten from target origin to proxy origin |
| HTML responses | Polyfill `<script>` injected before `</head>` |
| JavaScript responses | Transpiled via esbuild to `chrome70` target |
| WebSocket upgrades | Forwarded transparently to target |

## Diagnostic mode

During development, a diagnostic script was injected alongside the polyfills that displayed JS errors on-screen after 4 seconds (useful since the MFD has no accessible DevTools). To re-enable it, inject a `window.onerror` handler into the HTML response in `index.js`.

## Reference

- [signalk-mfd-plugin](https://github.com/htool/signalk-mfd-plugin) — source of the UDP multicast protocol details
- [hoekens-anchor-alarm](https://github.com/hoeken/hoekens-anchor-alarm) — the target app used during development; a Vite/Svelte SignalK webapp
