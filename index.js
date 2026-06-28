const http = require('http');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const PUBLISH_PORT = 2053;
const MULTICAST_GROUP = '239.2.1.1';
const PUBLISH_INTERVAL = 10 * 1000;

// Local route used to serve the plugin's bundled fallback icon for apps that
// have no icon of their own. Namespaced so it cannot collide with a proxied path.
const FALLBACK_ICON_ROUTE = '/__navico-embedder-icon';

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

// The bundled fallback icon, resolved once at load time.
const FALLBACK_ICON = [
  { file: 'icon.ico', mime: 'image/x-icon' },
  { file: 'icon.png', mime: 'image/png' },
].find((i) => {
  try {
    fs.accessSync(path.join(__dirname, i.file));
    return true;
  } catch {
    return false;
  }
});

module.exports = function (app) {
  let server = null;
  let publishInterval = null;

  // Look up the local Signal K server's HTTP port; everything is proxied there.
  // An explicit config override wins; otherwise mirror the server's own
  // resolution order: PORT env var, then settings.port, then the 3000 default.
  function getServerPort(options) {
    if (options && options.serverPort) return options.serverPort;
    return (
      Number(process.env.PORT)
      || (app.config && app.config.settings && app.config.settings.port)
      || 3000
    );
  }

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
          description: 'JWT token injected into all proxied requests. Required when Signal K has authentication enabled and read-only access disabled (e.g. MFDs that have no session cookie). Generate a token in Signal K admin → Security, or enable Allow Read-Only Access instead.',
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
            },
          },
        },
      },
    },

    start(options) {
      const ip = (options.ip && options.ip.trim()) || getLocalIp();
      const port = options.port || 8080;
      const serverPort = getServerPort(options);
      const skToken = (options.skToken || '').trim();

      const serverUrl = `http://${ip}:${port}`;
      // Everything is proxied to the local Signal K server, which serves all webapps.
      const targetParsed = new URL(`http://127.0.0.1:${serverPort}`);

      const apps = (options.apps || [])
        .filter((a) => a && a.enabled !== false && a.url)
        .map((a) => {
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

      const buildAnnouncement = (app2) => JSON.stringify({
        Version: '1',
        Source: 'signalk-navico-embedder',
        IP: ip,
        FeatureName: app2.label,
        Text: [{ Language: 'en', Name: app2.label, Description: app2.description }],
        Icon: app2.iconUrl,
        URL: app2.tileUrl,
        OnlyShowOnClientIP: 'true',
        BrowserPanel: {
          Enable: true,
          ProgressBarEnable: true,
          MenuText: [{ Language: 'en', Name: app2.label }],
        },
      });

      const publish = () => {
        if (apps.length === 0) return;
        const socket = dgram.createSocket('udp4');
        socket.once('listening', () => {
          let pending = apps.length;
          const done = () => {
            if (--pending <= 0) socket.close();
          };
          for (const app2 of apps) {
            socket.send(buildAnnouncement(app2), PUBLISH_PORT, MULTICAST_GROUP, (err) => {
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
                const result = await esbuild.transform(source, { target: 'chrome70', loader: 'js' });
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

      server.on('upgrade', (req, socket) => {
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

        proxyReq.on('upgrade', (proxyRes, proxySocket) => {
          const responseHead = [
            `HTTP/1.1 ${proxyRes.statusCode} Switching Protocols`,
            ...Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`),
            '\r\n',
          ].join('\r\n');
          socket.write(responseHead);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
          socket.on('error', () => proxySocket.destroy());
          proxySocket.on('error', () => socket.destroy());
        });

        proxyReq.on('error', () => socket.destroy());
        proxyReq.end();
      });

      server.listen(port, '0.0.0.0', () => {
        if (apps.length === 0) {
          app.setPluginStatus(`Proxy listening on ${serverUrl} — no apps configured yet (use Discover)`);
        } else {
          app.setPluginStatus(`Announcing ${apps.length} tile(s) to MFD via ${serverUrl} (IP: ${ip})`);
        }
        app.debug(`Proxy listening on ${serverUrl}, forwarding to ${targetParsed.origin}`);
      });

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
