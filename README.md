# signalk-navico-embedder

A SignalK plugin that presents your installed Signal K web apps as webapp tiles on B&G/Navico marine MFDs (Zeus, Vulcan, etc.). It handles the UDP multicast announcement protocol the MFD expects, and works around the significant browser limitations of the MFD's embedded Chromium.

## What it does

1. Runs an HTTP reverse proxy that forwards requests to the local Signal K server
2. Broadcasts UDP multicast announcements that tell the MFD to show a tile for each selected web app
3. Patches the proxied HTML, JS, and CSS to be compatible with the MFD's old Chromium browser

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
4. **Signal K server port** — leave blank to auto-detect (`PORT` env var, then the server's configured port, then `3000`). Set this only if the proxy cannot reach the Signal K server on the detected port.
5. **Signal K authentication token** — see [Authentication](#authentication) below.
6. **Client IP whitelist** — restrict which clients may connect to the proxy. See [Client IP whitelist](#client-ip-whitelist) below.
7. **Auto-discovery** — the panel scans the Signal K server for installed web apps as soon as it opens (shown with a spinner) and adds any new ones to the list below, starting **disabled** so you opt in explicitly. There's no manual discover button; it re-scans automatically every time you open the panel.
8. **MFD Apps** — the apps that become tiles on the MFD. For each entry you can:
   - drag to reorder,
   - edit the **name** and **description** shown on the tile,
   - toggle the **Enabled** checkbox (disabled apps are kept in the list but not announced).

   Apps stay in the list once discovered; there's currently no way to remove one, only disable it.

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

The quickest way is the **Generate Authentication Token** button in the plugin config panel. Choose an **Authentication level** (Read / Read/Write / Admin) first — it's sent as the requested `permissions` — then click Generate. It submits a Signal K [access request](https://signalk.org/specification/1.8.2/doc/access_requests.html) on the plugin's behalf; approve it under **Security → Access Requests** in the admin UI (the panel links straight there) and the issued token is filled in for you. The level selector and Generate button disappear once a token is present, leaving just the approval status. Then click **Save Configuration**.

To generate a token manually instead, use the **`signalk-generate-token` CLI** (see the [Signal K token docs](https://demo.signalk.org/documentation/Security/Generating_Tokens.html)). The token inherits the permissions of the user account it is generated against:

```
signalk-generate-token -u <username> -e <time-to-live> -s ~/.signalk/security.json
```

For example, `signalk-generate-token -u navico-mfd -e 1y -s ~/.signalk/security.json` creates a token valid for one year. Paste the result into **Plugin Config → Navico MFD Embedder → Signal K authentication token**, then save and restart the plugin.

When a token is configured the proxy:

- Adds `Authorization: Bearer <token>` to every forwarded HTTP request
- Appends `?token=<token>` to every WebSocket upgrade URL
- Injects `window.SK_TOKEN = "<token>"` into every HTML response so the webapp JS can authenticate its own fetch and WebSocket calls independently

This means the token only needs to be stored once (in the plugin config) and works transparently for all proxied apps.

### Restricted paths

Because the proxy injects the token into every upstream request, it will only forward a restricted set of paths — otherwise anything on the network that could reach the proxy port would have an authenticated gateway to the entire Signal K server. The proxy forwards:

- **Each enabled app's path** (and everything beneath it, so the app's own assets load). Disabling an app in the config removes its path from the allowlist.
- **`/signalk`** — all Signal K REST APIs and the WebSocket stream live here, so every proxied app needs it.
- **`/signalk-navico-embedder/`** — this plugin's own app-chooser page (the tile announced in launcher mode).

Everything else returns `403 Forbidden`. Notably the Signal K admin UI (`/admin`) is only reachable through the proxy if you enable the auto-discovered **SignalK Admin** app — so exposing it on the MFD is a deliberate, visible choice.

## Client IP whitelist

By default the proxy accepts connections from any client that can reach its port. To lock it down to specific devices, add one or more **IPv4 addresses** to the **Client IP whitelist** in the plugin config panel:

- Leave the list **empty** (the default) and any client may connect.
- Add one or more addresses and the whitelist becomes **active** — only clients whose IP is on the list may connect; every other client receives `403 Forbidden`, and disallowed WebSocket upgrades are dropped.

Add the MFD's own IPv4 address (find it in the MFD's network settings) plus any other devices you want to allow. The check runs before path routing, so a blocked client can't reach anything — not even the proxy's local icon route. Note the whitelist has no implicit exceptions: if you enable it, only the addresses you list get through (add `127.0.0.1` if you also want to reach the proxy from the Signal K server host itself). If the MFD gets its address via DHCP, consider a static lease so the whitelist doesn't lock it out on a lease change.

## Verified Hardware

| Works    | Make | MFD Model    | Browser      |
| -------- | ---- | ------------ | ------------ |
| ✅       | B&G  | Zeus 3S 9    | Chromium 69  |
| ✅       | B&G  | Zeus 3S 12   | Chromium 69  |
| ✅       | B&G  | Zeus 3S 16   | Chromium 69  |
| ✅       | B&G  | Zeus 3 12   | Chromium 69  |

## Verified Plugins

| Works    | Plugin                                                                     | Notes |
| -------- | -------------------------------------------------------------------------- | ----- |
| ✅       | [hoekens-anchor-alarm](https://www.npmjs.com/package/hoekens-anchor-alarm) |       |
| ✅       | [signalk-watch-schedule](https://www.npmjs.com/package/signalk-watch-schedule) |       |
| ✅       | [signalk-sailsense](https://www.npmjs.com/package/signalk-sailsense)       |       |
| ✅       | [signalk-instrumentpanel](https://www.npmjs.com/package/signalk-instrumentpanel) |       |
| ✅       | [signalk-sun-moon](https://www.npmjs.com/package/signalk-sun-moon)         |       |
| ✅       | [signalk-tides](https://www.npmjs.com/package/signalk-tides)               | Works, but the up/down emojis currently don't render properly |
| ⚠️       | SignalK Admin                                                              | Works, but is extremely slow |
| ⚠️       | [KIP](https://www.npmjs.com/package/@mxtommy/kip)                          | Loads, but doesn't see auth token and doesn't update. |
| ❌       | [Freeboard](https://www.npmjs.com/package/@signalk/freeboard-sk)           | Doesn't load. |

If you've tested a plugin on your MFD and would like it added to the list, please [open an issue or submit a PR](https://github.com/lukeescude/signalk-navico-embedder) with the plugin name and how well it works.


## Testers Wanted

If you run a Navico MFD (B&G, Simrad, Lowrance) we would love your help testing this plugin with both older and newer plotters.

For testing, install it from the app store and set `MFD display mode` to `Launcher` in the config.

Then, open the *SignalK Webapps* icon on your MFD.  If it doesnt show up, that's useful to know as well.  Please add an issue with your MFD make/model and we can try to find out a way to get it working.

Once it loads, click on the "Signalk Webapps" header to show the hidden debug information.  You can take a screenshot of the mfd by pressing `Power` and `Pages` (9 squares) which will save to your SD card.  The easiest way to access this is over FTP.  Use a ftp client like Cyberduck to connect to the IP of your MFD in *Anonymous* mode.  Screenshot will be in `/userdata/Screenshots`.  You can also take a screenshot from the phone app or just a photo of the screen.

From there, please add it as an issue on our tracker: https://github.com/lukeescude/signalk-navico-embedder

## Contributing

For the UDP announcement protocol, why the plugin proxies instead of pointing directly at
the target, the MFD's embedded-Chromium limitations and how they're worked around, and
build/test instructions, see [CONTRIBUTING.md](CONTRIBUTING.md).
