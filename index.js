const http = require('http');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');
const postcss = require('postcss');
const postcssPresetEnv = require('postcss-preset-env');
const valueParser = require('postcss-value-parser');

const PUBLISH_PORT = 2053;
const MULTICAST_GROUP = '239.2.1.1';
const PUBLISH_INTERVAL = 10 * 1000;

// Local route used to serve the plugin's bundled fallback icon for apps that
// have no icon of their own. Namespaced so it cannot collide with a proxied path.
const FALLBACK_ICON_ROUTE = '/__navico-embedder-icon';

// Path of this plugin's own app-chooser webapp (served by Signal K from /public).
// In "launcher" display mode this single page is announced as the only MFD tile,
// and the user picks an app to open from there.
const LAUNCHER_PATH = '/signalk-navico-embedder/';

const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
]);

// Strip from requests — the MFD sends cached ETags/dates from other origins,
// causing the target to 304 with no body even though the MFD has nothing cached.
// Also strip accept-encoding so the server sends plain responses we can inject into.
const STRIP_REQUEST_HEADERS = new Set([
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'accept-encoding',
]);

// postcss-preset-env has no fallback for the CSS min()/max() value functions
// (unsupported before Chrome 79) because there's no way to statically know which
// argument wins — it depends on the actual viewport at runtime. Tailwind's own
// convention is min(<viewport-relative>, <fixed cap>), e.g. width: min(92vw, 900px)
// for a dialog that should never overflow a small screen. Old Chromium treats the
// whole declaration as invalid and drops it, leaving no width at all — collapsing
// layouts that depend on it. Emitting the first argument alone as a same-property
// fallback keeps the "don't overflow" behavior (the one that matters on a small MFD
// screen) at the cost of the upper/lower cap on larger ones.
function minMaxFallbackPlugin() {
  return {
    postcssPlugin: 'mfd-min-max-fallback',
    Declaration(decl) {
      const trimmed = decl.value.trim();
      if (!/^(min|max)\(/i.test(trimmed) || !trimmed.endsWith(')')) return;
      const parsed = valueParser(trimmed);
      // Only handle a value that is a single min()/max() call — anything more
      // complex (e.g. multiple functions in a grid-template-columns list) is left
      // alone rather than risk an incorrect partial fallback.
      if (parsed.nodes.length !== 1 || parsed.nodes[0].type !== 'function') return;
      const firstArgNodes = [];
      for (const node of parsed.nodes[0].nodes) {
        if (node.type === 'div' && node.value === ',') break;
        firstArgNodes.push(node);
      }
      const fallback = valueParser.stringify(firstArgNodes).trim();
      if (!fallback) return;
      decl.cloneBefore({ value: fallback });
    },
  };
}
minMaxFallbackPlugin.postcss = true;

// Downlevels modern CSS (cascade layers, oklch/color-mix, :is()) that apps built
// with current tooling (e.g. Tailwind v4) emit but the MFD's old Chromium can't
// parse. Unrecognized at-rules like @layer are dropped wholesale by old browsers,
// which silently deletes an app's reset/base styles — seen as huge default-UA-styled
// headings on the MFD even though the same page looks fine in a modern browser.
const cssProcessor = postcss([minMaxFallbackPlugin(), postcssPresetEnv({ browsers: 'Chrome >= 70' })]);

// Polyfills for APIs missing in the MFD's embedded Chromium (< Chrome 73).
const POLYFILLS_SCRIPT = `<script>
(function(w) {
  if (!Object.fromEntries) {
    Object.fromEntries = function(entries) {
      var o = {};
      for (var e of entries) { o[e[0]] = e[1]; }
      return o;
    };
  }
  if (!Array.prototype.flat) {
    Array.prototype.flat = function flat(depth) {
      var d = depth === undefined ? 1 : Math.floor(depth);
      if (d < 1) return Array.prototype.slice.call(this);
      return Array.prototype.reduce.call(this, function(acc, val) {
        Array.isArray(val)
          ? acc.push.apply(acc, Array.prototype.flat.call(val, d - 1))
          : acc.push(val);
        return acc;
      }, []);
    };
  }
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function(fn, ctx) {
      return Array.prototype.flat.call(Array.prototype.map.call(this, fn, ctx), 1);
    };
  }
  if (!Array.prototype.at) {
    Array.prototype.at = function(i) {
      var n = Math.trunc(i) || 0;
      if (n < 0) n += this.length;
      return n >= 0 && n < this.length ? this[n] : undefined;
    };
  }
  if (!String.prototype.at) {
    String.prototype.at = function(i) {
      var n = Math.trunc(i) || 0;
      if (n < 0) n += this.length;
      return n >= 0 && n < this.length ? this.charAt(n) : undefined;
    };
  }
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function(s, r) {
      return s instanceof RegExp ? this.replace(s, r) : this.split(s).join(r);
    };
  }
  if (!Object.hasOwn) {
    Object.hasOwn = function(obj, prop) {
      return Object.prototype.hasOwnProperty.call(obj, prop);
    };
  }
  if (!Promise.allSettled) {
    Promise.allSettled = function(ps) {
      return Promise.all(Array.prototype.map.call(ps, function(p) {
        return Promise.resolve(p).then(
          function(v) { return { status: 'fulfilled', value: v }; },
          function(r) { return { status: 'rejected', reason: r }; }
        );
      }));
    };
  }
  if (typeof globalThis === 'undefined') { w.globalThis = w; }
  if (typeof w.queueMicrotask !== 'function') {
    w.queueMicrotask = function(fn) { Promise.resolve().then(fn); };
  }
})(window);
</script>`;

function getLocalIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

// The bundled fallback icon (shipped under public/), resolved once at load time.
const FALLBACK_ICON = [
  { file: path.join('public', 'icon.ico'), mime: 'image/x-icon' },
  { file: path.join('public', 'icon.png'), mime: 'image/png' },
].find((i) => {
  try {
    fs.accessSync(path.join(__dirname, i.file));
    return true;
  } catch {
    return false;
  }
});

// Look up the local Signal K server's HTTP port; everything is proxied there.
// An explicit config override wins; otherwise mirror the server's own
// resolution order: PORT env var, then settings.port, then the 3000 default.
function getServerPort(app, options) {
  if (options && options.serverPort) return options.serverPort;
  return (
    Number(process.env.PORT)
    || (app.config && app.config.settings && app.config.settings.port)
    || 3000
  );
}

// Build the MFD UDP announcement payload for a single tile. Pure: depends only
// on the advertised IP and the tile's resolved label/description/icon/url.
function buildAnnouncement(ip, tile) {
  return JSON.stringify({
    Version: '1',
    Source: 'signalk-navico-embedder',
    IP: ip,
    FeatureName: tile.label,
    Text: [{ Language: 'en', Name: tile.label, Description: tile.description }],
    Icon: tile.iconUrl,
    URL: tile.tileUrl,
    OnlyShowOnClientIP: 'true',
    BrowserPanel: {
      Enable: true,
      ProgressBarEnable: true,
      MenuText: [{ Language: 'en', Name: tile.label }],
    },
  });
}

// Derive what to announce/publish from the saved options. Pure transform of
// config -> { mode, enabledApps, apps, webapps }:
//   - apps:    the tiles announced over UDP (one per enabled app, or a single
//              launcher tile in launcher mode). URLs are absolute (the MFD opens
//              them through this proxy).
//   - webapps: the enabled-app list published as a delta for the standalone
//              app-chooser webapp. URLs are kept server-relative so they resolve
//              whether the chooser is opened directly or through the proxy.
function buildAppModel(options, ip, port) {
  const serverUrl = `http://${ip}:${port}`;
  const enabledApps = (options.apps || []).filter((a) => a && a.enabled !== false && a.url);
  const mode = options.mode === 'launcher' ? 'launcher' : 'individual';

  const individualApps = enabledApps.map((a) => {
    const appPath = a.url.startsWith('/') ? a.url : `/${a.url}`;
    const tileUrl = `${serverUrl}${appPath}`;
    let iconUrl;
    if (a.icon && /^https?:\/\//.test(a.icon)) {
      iconUrl = a.icon;
    } else if (a.icon) {
      iconUrl = `${serverUrl}${a.icon.startsWith('/') ? a.icon : `/${a.icon}`}`;
    } else if (FALLBACK_ICON) {
      iconUrl = `${serverUrl}${FALLBACK_ICON_ROUTE}`;
    } else {
      iconUrl = tileUrl;
    }
    return {
      label: a.label || appPath,
      description: a.description || '',
      tileUrl,
      iconUrl,
    };
  });

  // In launcher mode we announce just one tile — this plugin's own app-chooser
  // page — instead of one tile per app. The chooser then lists every enabled
  // web app (read from the webapps delta) for the user to open.
  let apps;
  if (mode === 'launcher') {
    const launcherUrl = `${serverUrl}${LAUNCHER_PATH}`;
    apps = [
      {
        label: 'SignalK Webapps',
        description: 'Open the app launcher to browse all enabled web apps.',
        tileUrl: launcherUrl,
        iconUrl: FALLBACK_ICON ? `${serverUrl}${FALLBACK_ICON_ROUTE}` : launcherUrl,
      },
    ];
  } else {
    apps = individualApps;
  }

  const webapps = enabledApps.map((a) => {
    const appPath = a.url.startsWith('/') ? a.url : `/${a.url}`;
    let icon = '';
    if (a.icon && /^https?:\/\//.test(a.icon)) {
      icon = a.icon;
    } else if (a.icon) {
      icon = a.icon.startsWith('/') ? a.icon : `/${a.icon}`;
    }
    return {
      name: a.label || appPath,
      url: appPath,
      icon,
      description: a.description || '',
    };
  });

  return { mode, enabledApps, apps, webapps };
}

module.exports = function (app) {
  let server = null;
  let publishInterval = null;

  return {
    id: 'signalk-navico-embedder',
    name: 'Navico MFD Embedder',
    description: 'Embeds Signal K web apps as webapp tiles on B&G/Navico MFDs via UDP multicast announcement',

    schema: {
      type: 'object',
      description:
        'Configure this plugin from Server → Plugin Config. Use the embedded "Discover Installed Webapps" '
        + 'button to auto-detect web apps, then enable the ones you want to appear as tiles on the MFD.',
      required: [],
      properties: {
        mode: {
          type: 'string',
          title: 'MFD Display Mode',
          description:
            'Individual Apps: announce every enabled web app below as its own tile on the MFD. '
            + 'Launcher: announce a single tile that opens this plugin\'s app-chooser page, '
            + 'from which all enabled web apps can be launched.',
          enum: ['individual', 'launcher'],
          enumNames: ['Individual Apps', 'Launcher'],
          default: 'individual',
        },
        ip: {
          type: 'string',
          title: 'Local IP address override',
          description: 'Leave blank to auto-detect. Set this if the machine has multiple network interfaces and the wrong one is selected.',
        },
        port: {
          type: 'number',
          title: 'Proxy port',
          description: 'The HTTP port this proxy listens on.',
          default: 8080,
        },
        serverPort: {
          type: 'number',
          title: 'Signal K server port override',
          description: 'Leave blank to auto-detect (PORT env var, then the server\'s configured port, then 3000). Set this if the proxy cannot reach the Signal K server on the detected port.',
        },
        skToken: {
          type: 'string',
          title: 'Signal K authentication token',
          description: 'JWT token injected into all proxied requests. Required when Signal K has authentication enabled and read-only access disabled (e.g. MFDs that have no session cookie). Use the "Generate Authentication Token" button in the plugin config panel, or enable Allow Read-Only Access instead.',
        },
        apps: {
          type: 'array',
          title: 'MFD Apps',
          description:
            'Web apps to announce as tiles on the MFD. Installed webapps are added here automatically '
            + 'by the Discover button. Reorder, disable, or override name/description as needed.',
          default: [],
          items: {
            type: 'object',
            required: ['url'],
            properties: {
              enabled: { type: 'boolean', title: 'Enabled', default: true },
              url: { type: 'string', title: 'URL', description: 'Path of the web app (e.g. /@signalk/freeboard-sk/).' },
              label: { type: 'string', title: 'Name', description: 'Name shown on the MFD tile.' },
              description: { type: 'string', title: 'Description', description: 'Description shown on the MFD tile.' },
              icon: {
                type: 'string',
                title: 'Icon',
                description:
                  'Icon shown on the MFD tile — a server-relative path (e.g. /@signalk/freeboard-sk/icon.png) '
                  + 'or an absolute http(s) URL. Set automatically by Discover; leave blank to use the default icon.',
              },
            },
          },
        },
      },
    },

    start(options) {
      const ip = (options.ip && options.ip.trim()) || getLocalIp();
      const port = options.port || 8080;
      const serverPort = getServerPort(app, options);
      const skToken = (options.skToken || '').trim();

      const serverUrl = `http://${ip}:${port}`;
      // Everything is proxied to the local Signal K server, which serves all webapps.
      const targetParsed = new URL(`http://127.0.0.1:${serverPort}`);

      // The tiles announced over UDP and the webapp list published as a delta are
      // both derived from the saved options — see buildAppModel.
      const { mode, enabledApps, apps, webapps } = buildAppModel(options, ip, port);

      const publish = () => {
        if (apps.length === 0) return;
        const socket = dgram.createSocket('udp4');
        socket.once('listening', () => {
          let pending = apps.length;
          const done = () => {
            if (--pending <= 0) socket.close();
          };
          for (const app2 of apps) {
            socket.send(buildAnnouncement(ip, app2), PUBLISH_PORT, MULTICAST_GROUP, (err) => {
              if (err) {
                app.error(`Multicast send error: ${err.message}`);
              } else {
                app.debug(`Announced tile "${app2.label}" -> ${app2.tileUrl}`);
              }
              done();
            });
          }
        });
        socket.bind(PUBLISH_PORT, ip);
      };

      server = http.createServer((req, res) => {
        if (FALLBACK_ICON && req.url === FALLBACK_ICON_ROUTE) {
          const icon = fs.readFileSync(path.join(__dirname, FALLBACK_ICON.file));
          res.writeHead(200, { 'Content-Type': FALLBACK_ICON.mime, 'Cache-Control': 'max-age=3600' });
          res.end(icon);
          return;
        }

        const forwardHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) {
            forwardHeaders[k] = v;
          }
        }
        forwardHeaders.host = targetParsed.host;
        if (skToken) forwardHeaders['authorization'] = 'Bearer ' + skToken;

        const reqOptions = {
          hostname: targetParsed.hostname,
          port: parseInt(targetParsed.port) || 80,
          path: req.url,
          method: req.method,
          headers: forwardHeaders,
        };

        const proxyReq = http.request(reqOptions, (proxyRes) => {
          const headers = {};
          for (const [k, v] of Object.entries(proxyRes.headers)) {
            if (!STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) {
              if (k.toLowerCase() === 'location' && v.startsWith(targetParsed.origin)) {
                headers[k] = v.replace(targetParsed.origin, serverUrl);
              } else {
                headers[k] = v;
              }
            }
          }
          const contentType = proxyRes.headers['content-type'] || '';
          app.debug(`${req.method} ${req.url} -> ${proxyRes.statusCode} (${contentType || 'no content-type'})`);

          if (contentType.includes('text/html')) {
            const chunks = [];
            proxyRes.on('data', (chunk) => chunks.push(chunk));
            proxyRes.on('end', () => {
              let body = Buffer.concat(chunks).toString('utf8');
              const tokenScript = skToken
                ? '<script>window.SK_TOKEN=' + JSON.stringify(skToken) + ';</script>\n'
                : '';
              body = body.replace('</head>', POLYFILLS_SCRIPT + '\n' + tokenScript + '</head>');
              delete headers['content-length'];
              res.writeHead(proxyRes.statusCode, headers);
              res.end(body);
            });
          } else if (contentType.includes('javascript')) {
            const chunks = [];
            proxyRes.on('data', (chunk) => chunks.push(chunk));
            proxyRes.on('end', async () => {
              const source = Buffer.concat(chunks).toString('utf8');
              try {
                const result = await esbuild.transform(source, { target: 'chrome70', loader: 'js', minify: true });
                delete headers['content-length'];
                res.writeHead(proxyRes.statusCode, headers);
                res.end(result.code);
                app.debug(`  Transpiled ${req.url} (${source.length} -> ${result.code.length} bytes)`);
              } catch (err) {
                app.error(`  esbuild failed for ${req.url}: ${err.message}`);
                delete headers['content-length'];
                res.writeHead(proxyRes.statusCode, headers);
                res.end(source);
              }
            });
          } else if (contentType.includes('text/css')) {
            const chunks = [];
            proxyRes.on('data', (chunk) => chunks.push(chunk));
            proxyRes.on('end', async () => {
              const source = Buffer.concat(chunks).toString('utf8');
              try {
                const result = await cssProcessor.process(source, { from: undefined });
                delete headers['content-length'];
                res.writeHead(proxyRes.statusCode, headers);
                res.end(result.css);
                app.debug(`  Downleveled CSS ${req.url} (${source.length} -> ${result.css.length} bytes)`);
              } catch (err) {
                app.error(`  postcss failed for ${req.url}: ${err.message}`);
                delete headers['content-length'];
                res.writeHead(proxyRes.statusCode, headers);
                res.end(source);
              }
            });
          } else {
            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
          }
        });

        proxyReq.on('error', (err) => {
          app.error(`Proxy error [${req.method} ${req.url}]: ${err.message}`);
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Proxy error: ' + err.message);
          }
        });

        req.pipe(proxyReq);
      });

      server.on('upgrade', (req, socket, reqHead) => {
        // Disable Nagle on the MFD socket immediately — small WS packets should
        // not be buffered; without this the upgrade handshake itself can be delayed.
        socket.setNoDelay(true);

        const wsHeaders = {};
        for (const [k, v] of Object.entries(req.headers)) {
          if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) {
            wsHeaders[k] = v;
          }
        }
        wsHeaders.host = targetParsed.host;
        if (skToken) wsHeaders['authorization'] = 'Bearer ' + skToken;

        // Append token as query param — Signal K accepts ?token= on WebSocket URLs
        let wsPath = req.url;
        if (skToken) {
          wsPath += (wsPath.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(skToken);
        }

        const proxyReq = http.request({
          hostname: targetParsed.hostname,
          port: parseInt(targetParsed.port) || 80,
          path: wsPath,
          headers: wsHeaders,
        });

        // Manual timer covers only the upgrade handshake — cancelled on success or
        // error so it never fires against an already-established WS tunnel.
        // (proxyReq.setTimeout would stay active on the socket indefinitely and
        //  would kill the tunnel during any quiet period with no incoming data.)
        const upgradeTimer = setTimeout(() => {
          app.debug(`WS upgrade timeout: ${req.url}`);
          proxyReq.destroy();
          socket.destroy();
        }, 10000);

        // If the MFD disconnects before the upstream upgrade completes, abort it.
        socket.on('error', () => {
          clearTimeout(upgradeTimer);
          proxyReq.destroy();
        });
        socket.on('close', () => {
          clearTimeout(upgradeTimer);
          proxyReq.destroy();
        });

        proxyReq.on('upgrade', (proxyRes, proxySocket, resHead) => {
          clearTimeout(upgradeTimer);
          proxySocket.setNoDelay(true);

          // If SK rejected the upgrade (e.g. 401 auth failure), don't tunnel
          // a non-WebSocket response to the browser as if it were a WS stream.
          if (proxyRes.statusCode !== 101) {
            app.debug(`WS upgrade rejected ${req.url} -> ${proxyRes.statusCode}`);
            proxySocket.destroy();
            socket.destroy();
            return;
          }

          app.debug(`WS tunnel up: ${req.url}`);
          const responseHead = [
            `HTTP/1.1 ${proxyRes.statusCode} Switching Protocols`,
            ...Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`),
            '\r\n',
          ].join('\r\n');
          socket.write(responseHead);
          // Node's HTTP parser hands back any upstream bytes it already read past the
          // 101 response headers (e.g. the first WS frame, when SK writes it fast enough
          // to land in the same TCP read as the handshake) via this `head` buffer rather
          // than a later 'data' event. Forwarding it before piping avoids silently
          // dropping that frame — which was intermittently eating the initial "hello".
          if (resHead && resHead.length) socket.write(resHead);
          if (reqHead && reqHead.length) proxySocket.write(reqHead);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
          // Cross-link both error and close so either side tearing down cleans up the other.
          socket.on('error', () => proxySocket.destroy());
          socket.on('close', () => proxySocket.destroy());
          proxySocket.on('error', () => socket.destroy());
          proxySocket.on('close', () => socket.destroy());
        });

        proxyReq.on('error', (err) => {
          clearTimeout(upgradeTimer);
          app.debug(`WS upstream error ${req.url}: ${err.message}`);
          socket.destroy();
        });
        proxyReq.end();
      });

      server.listen(port, '0.0.0.0', () => {
        if (mode === 'launcher') {
          app.setPluginStatus(
            `Announcing app launcher to MFD via ${serverUrl} `
            + `(${enabledApps.length} app(s) available, IP: ${ip})`,
          );
        } else if (apps.length === 0) {
          app.setPluginStatus(`Proxy listening on ${serverUrl} — no apps configured yet (use Discover)`);
        } else {
          app.setPluginStatus(`Announcing ${apps.length} tile(s) to MFD via ${serverUrl} (IP: ${ip})`);
        }
        app.debug(`Proxy listening on ${serverUrl}, forwarding to ${targetParsed.origin}`);
      });

      // Publish the enabled-app list to the data model so the standalone
      // app-chooser webapp can fetch it (works for unauthenticated clients when
      // read-only access is enabled, and through the proxy with token injection).
      app.handleMessage('signalk-navico-embedder', {
        updates: [
          {
            values: [{ path: 'plugins.signalk-navico-embedder.webapps', value: webapps }],
          },
        ],
      });
      app.debug(`Published ${webapps.length} webapp(s) to plugins.signalk-navico-embedder.webapps`);

      publish();
      publishInterval = setInterval(publish, PUBLISH_INTERVAL);
    },

    stop() {
      if (publishInterval) {
        clearInterval(publishInterval);
        publishInterval = null;
      }
      if (server) {
        server.close();
        server = null;
      }
      app.setPluginStatus('Stopped');
    },
  };
};

// Pure helpers exposed for the test suite. Not part of the Signal K plugin API;
// the server only ever calls the factory function exported above.
module.exports.internal = {
  getLocalIp,
  getServerPort,
  buildAnnouncement,
  buildAppModel,
  FALLBACK_ICON_ROUTE,
  LAUNCHER_PATH,
};
