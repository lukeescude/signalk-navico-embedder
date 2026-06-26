const http = require('http');
const dgram = require('dgram');
const os = require('os');
const path = require('path');
const url = require('url');
const esbuild = require('esbuild');

const PUBLISH_PORT = 2053;
const MULTICAST_GROUP = '239.2.1.1';
const PUBLISH_INTERVAL = 10 * 1000;

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

module.exports = function (app) {
  let server = null;
  let publishInterval = null;

  return {
    id: 'signalk-navico-embedder',
    name: 'Navico MFD Embedder',
    description: 'Embeds a URL as a webapp tile on B&G/Navico MFDs via UDP multicast announcement',

    schema: {
      type: 'object',
      required: ['port', 'targetUrl'],
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
        targetUrl: {
          type: 'string',
          title: 'Target URL',
          description: 'Full URL of the web app to proxy to the MFD (e.g. http://localhost:3000/app/).',
        },
        tileName: {
          type: 'string',
          title: 'Tile name',
          description: 'Name shown on the MFD tile.',
          default: 'My App',
        },
        tileDescription: {
          type: 'string',
          title: 'Tile description',
          description: 'Description shown on the MFD tile.',
          default: '',
        },
      },
    },

    start(options) {
      const ip = (options.ip && options.ip.trim()) || getLocalIp();
      const port = options.port || 8080;
      const targetUrl = options.targetUrl;
      const tileName = options.tileName || 'My App';
      const tileDescription = options.tileDescription || '';

      const serverUrl = `http://${ip}:${port}`;
      const targetParsed = new url.URL(targetUrl);
      const tileUrl = `${serverUrl}${targetParsed.pathname}`;

      const ICONS = [
        { file: 'icon.ico', route: '/icon.ico', mime: 'image/x-icon' },
        { file: 'icon.png', route: '/icon.png', mime: 'image/png' },
      ];
      const activeIcon = ICONS.find((i) => {
        try {
          require('fs').accessSync(path.join(__dirname, i.file));
          return true;
        } catch {
          return false;
        }
      });
      const iconUrl = activeIcon ? `${serverUrl}${activeIcon.route}` : tileUrl;

      const buildAnnouncement = () => JSON.stringify({
        Version: '1',
        Source: 'signalk-navico-embedder',
        IP: ip,
        FeatureName: tileName,
        Text: [{ Language: 'en', Name: tileName, Description: tileDescription }],
        Icon: iconUrl,
        URL: tileUrl,
        OnlyShowOnClientIP: 'true',
        BrowserPanel: {
          Enable: true,
          ProgressBarEnable: true,
          MenuText: [{ Language: 'en', Name: tileName }],
        },
      });

      const publish = () => {
        const msg = buildAnnouncement();
        const socket = dgram.createSocket('udp4');
        socket.once('listening', () => {
          socket.send(msg, PUBLISH_PORT, MULTICAST_GROUP, (err) => {
            socket.close();
            if (err) {
              app.error(`Multicast send error: ${err.message}`);
            } else {
              app.debug(`Announced tile "${tileName}" -> ${tileUrl}`);
            }
          });
        });
        socket.bind(PUBLISH_PORT, ip);
      };

      server = http.createServer((req, res) => {
        if (activeIcon && req.url === activeIcon.route) {
          const icon = require('fs').readFileSync(path.join(__dirname, activeIcon.file));
          res.writeHead(200, { 'Content-Type': activeIcon.mime, 'Cache-Control': 'max-age=3600' });
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

        const options = {
          hostname: targetParsed.hostname,
          port: parseInt(targetParsed.port) || 80,
          path: req.url,
          method: req.method,
          headers: forwardHeaders,
        };

        const proxyReq = http.request(options, (proxyRes) => {
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
              body = body.replace('</head>', POLYFILLS_SCRIPT + '\n</head>');
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

        const proxyReq = http.request({
          hostname: targetParsed.hostname,
          port: parseInt(targetParsed.port) || 80,
          path: req.url,
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
        app.setPluginStatus(`Proxying ${targetUrl} -> MFD tile at ${tileUrl} (IP: ${ip})`);
        app.debug(`Proxy listening on ${serverUrl}`);
        app.debug(`Forwarding to ${targetParsed.origin}`);
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
