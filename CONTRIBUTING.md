# Contributing

This document covers the implementation details behind `signalk-navico-embedder`: the
MFD announcement protocol, why the plugin proxies instead of pointing at the target
directly, the MFD's browser limitations and how they're worked around, and how to build
and test the plugin locally. If you just want to install and configure the plugin, see
[README.md](README.md) instead.

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

The B&G Zeus3S 12 runs an **embedded Chromium 69**. This plugin fixes three categories of issues:

### Syntax issues — fixed with esbuild transpilation

Modern JavaScript build tools output ES2020+ syntax. The MFD's Chromium doesn't support optional chaining (`?.`) or nullish coalescing (`??`). All `application/javascript` responses are transpiled and minified to `chrome69` target via esbuild — minification matters here because the unminified transpiled output can be meaningfully larger than the original bundle, and the MFD's hardware is slow enough that the extra parse/download weight is noticeable.

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

### CSS issues — fixed with PostCSS downleveling

Apps built with current tooling (e.g. Tailwind v4) emit CSS the MFD's Chromium can't
parse: cascade layers (`@layer`), `oklch()`/`color-mix()` colors, and `:is()`. All
`text/css` responses are run through `postcss-preset-env` targeting `Chrome >= 69`,
which matters more than it sounds — unrecognized at-rules like `@layer` are dropped
**wholesale** by old browsers, including everything inside them. Since apps commonly
wrap their entire reset/base stylesheet in `@layer base { ... }`, losing that layer
silently deletes the reset, which shows up as huge default-browser-styled headings and
wrong text colors on the MFD even though the same page looks fine in a modern browser.

One thing `postcss-preset-env` can't fix: the CSS `min()`/`max()` value functions
(unsupported before Chrome 79) have no static fallback, because which argument wins
depends on the actual runtime viewport. A small custom PostCSS plugin in `index.js`
handles the common case — Tailwind's own convention is
`min(<viewport-relative>, <fixed cap>)`, e.g. `width: min(92vw, 900px)` for a dialog
that shouldn't overflow a small screen — by emitting the first argument as a
same-property fallback. Old Chromium keeps that fallback and ignores the invalid
`min()`/`max()` line; modern browsers do the reverse. This trades away the upper/lower
cap on large screens to guarantee the layout never overflows a small MFD screen, which
matters more here.

## Proxy behaviour summary

| Request/Response                      | What the proxy does                                                                      |
| ------------------------------------- | ---------------------------------------------------------------------------------------- |
| Conditional cache headers in request  | Stripped — prevents spurious 304s                                                        |
| `Accept-Encoding` in request          | Stripped — ensures uncompressed responses                                                |
| `X-Frame-Options` in response         | Stripped                                                                                 |
| `Content-Security-Policy` in response | Stripped                                                                                 |
| `Location` redirect headers           | Rewritten from target origin to proxy origin                                             |
| HTML responses                        | Polyfill `<script>` injected before `</head>`; `window.SK_TOKEN` set if token configured |
| JavaScript responses                  | Transpiled and minified via esbuild to `chrome69` target                                 |
| CSS responses                         | Downleveled via `postcss-preset-env` to `chrome69` target (see above)                    |
| WebSocket upgrades                    | Forwarded to target; `Authorization` header and `?token=` appended if token configured   |
| All HTTP requests (if token set)      | `Authorization: Bearer <token>` header added                                             |
| Client IP not on whitelist (if set)   | Refused with `403 Forbidden` (WS upgrades dropped) before any routing or path check       |
| Path outside the allowlist            | Refused with `403 Forbidden` (WS upgrades dropped)                                        |

## Development

The embedded configurator is a React 19 component in [`src/configpanel/`](src/configpanel/),
exposed to the Signal K admin UI via Webpack Module Federation. After editing it, rebuild
the bundle into `public/` (which is auto-mounted and shipped with the package):

```bash
npm run build:config
```

The backend plugin ([`index.js`](index.js)) is plain CommonJS and needs no build step.
`npm run prepublishOnly` rebuilds the configurator automatically before publishing.

### Testing against the MFD's actual browser

A modern browser will not reproduce most MFD-specific bugs — the whole point of this
plugin is compatibility with a Chromium from roughly 2018. When a fix needs verifying
against the real thing rather than guesswork, download the matching historical
Chromium build straight from Google's snapshot archive and drive it over the DevTools
protocol:

```bash
# Find the Chromium revision for a given Chrome milestone, e.g. 69 (the MFD's actual version):
curl -s "https://chromiumdash.appspot.com/fetch_milestones?mstone=69" | grep chromium_main_branch_position

# Download and unzip the matching build (Mac example; Linux/Win paths also exist):
curl -o chrome-mac.zip "https://commondatastorage.googleapis.com/chromium-browser-snapshots/Mac/<revision>/chrome-mac.zip"
unzip chrome-mac.zip

# Launch headless with remote debugging (on Apple Silicon this runs fine under Rosetta):
./chrome-mac/Chromium.app/Contents/MacOS/Chromium \
  --headless --disable-gpu --no-sandbox \
  --remote-debugging-port=9333 --user-data-dir=/tmp/chrome69profile about:blank
```

From there, the `chrome-remote-interface` npm package can navigate, click/tap, and read
console exceptions directly from that exact browser — modern tools like Playwright
generally can't drive a CDP endpoint this old, since the protocol has moved on since
2018. This is how the WebSocket proxy, esbuild minification, and CSS downleveling fixes
in this codebase were verified.

### Tests

The plugin has a test suite built on Node's built-in test runner (no extra test-framework
dependencies). It covers the config-to-announcement transforms and the proxy's
runtime behaviour — header rewriting, HTML/token injection, JS transpilation, CSS
downleveling, the fallback-icon route, and the start/stop lifecycle (UDP is stubbed, so no
multicast traffic is emitted):

```bash
npm test          # run once
npm run test:watch # re-run on change
```

## Reference

- [signalk-mfd-plugin](https://github.com/htool/signalk-mfd-plugin) — source of the UDP multicast protocol details
- [hoekens-anchor-alarm](https://github.com/hoeken/hoekens-anchor-alarm) — a Vite/Svelte SignalK webapp; the app this proxy was originally developed against