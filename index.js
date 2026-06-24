const http = require('http');
const dgram = require('dgram');
const fs = require('fs');
const path = require('path');
const url = require('url');
const esbuild = require('esbuild');

const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));

const PUBLISH_PORT = 2053;
const MULTICAST_GROUP = '239.2.1.1';
const PUBLISH_INTERVAL = 10 * 1000;

const serverUrl = `http://${config.ip}:${config.port}`;
const targetParsed = new url.URL(config.targetUrl);

// The URL we announce: same path as target but via our host so the MFD routes through us
const tileUrl = `${serverUrl}${targetParsed.pathname}`;

// Strip from responses — prevent the MFD browser from being blocked
const STRIP_RESPONSE_HEADERS = new Set([
  'x-frame-options',
  'content-security-policy',
  'content-security-policy-report-only',
]);

// Strip from requests — the MFD sends cached ETags/dates from other origins,
// causing the target to 304 with no body even though the MFD has nothing cached.
// Also strip accept-encoding so the server sends plain (uncompressed) responses
// that we can buffer and inject into safely.
const STRIP_REQUEST_HEADERS = new Set([
  'if-none-match',
  'if-modified-since',
  'if-match',
  'if-unmodified-since',
  'if-range',
  'accept-encoding',
]);

// Polyfills for APIs missing in the MFD's embedded Chromium (< Chrome 73).
// These are injected before the app JS runs so they're available at startup.
const POLYFILLS_SCRIPT = `<script>
(function(w) {
  // Object.fromEntries — Chrome 73+
  if (!Object.fromEntries) {
    Object.fromEntries = function(entries) {
      var o = {};
      for (var e of entries) { o[e[0]] = e[1]; }
      return o;
    };
  }
  // Array.prototype.flat — Chrome 69+
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
  // Array.prototype.flatMap — Chrome 69+
  if (!Array.prototype.flatMap) {
    Array.prototype.flatMap = function(fn, ctx) {
      return Array.prototype.flat.call(Array.prototype.map.call(this, fn, ctx), 1);
    };
  }
  // Array.prototype.at — Chrome 92+
  if (!Array.prototype.at) {
    Array.prototype.at = function(i) {
      var n = Math.trunc(i) || 0;
      if (n < 0) n += this.length;
      return n >= 0 && n < this.length ? this[n] : undefined;
    };
  }
  // String.prototype.at — Chrome 92+
  if (!String.prototype.at) {
    String.prototype.at = function(i) {
      var n = Math.trunc(i) || 0;
      if (n < 0) n += this.length;
      return n >= 0 && n < this.length ? this.charAt(n) : undefined;
    };
  }
  // String.prototype.replaceAll — Chrome 85+
  if (!String.prototype.replaceAll) {
    String.prototype.replaceAll = function(s, r) {
      return s instanceof RegExp ? this.replace(s, r) : this.split(s).join(r);
    };
  }
  // Object.hasOwn — Chrome 93+
  if (!Object.hasOwn) {
    Object.hasOwn = function(obj, prop) {
      return Object.prototype.hasOwnProperty.call(obj, prop);
    };
  }
  // Promise.allSettled — Chrome 76+
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
  // globalThis — Chrome 71+
  if (typeof globalThis === 'undefined') { w.globalThis = w; }
  // queueMicrotask — Chrome 71+
  if (typeof w.queueMicrotask !== 'function') {
    w.queueMicrotask = function(fn) { Promise.resolve().then(fn); };
  }
})(window);
</script>`;


const ICONS = [
  { file: 'icon.ico', route: '/icon.ico', mime: 'image/x-icon' },
  { file: 'icon.png', route: '/icon.png', mime: 'image/png' },
];
const activeIcon = ICONS.find(i => fs.existsSync(path.join(__dirname, i.file)));
const iconUrl = activeIcon ? `${serverUrl}${activeIcon.route}` : tileUrl;

const server = http.createServer((req, res) => {
  // Serve the local icon directly rather than proxying
  if (activeIcon && req.url === activeIcon.route) {
    const icon = fs.readFileSync(path.join(__dirname, activeIcon.file));
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
        // Rewrite Location headers so redirects stay on our proxy
        if (k.toLowerCase() === 'location' && v.startsWith(targetParsed.origin)) {
          headers[k] = v.replace(targetParsed.origin, serverUrl);
        } else {
          headers[k] = v;
        }
      }
    }
    const contentType = proxyRes.headers['content-type'] || '';
    console.log(`${req.method} ${req.url} -> ${proxyRes.statusCode} (${contentType || 'no content-type'})`);

    if (contentType.includes('text/html')) {
      // Buffer so we can inject the diagnostic script
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', () => {
        let body = Buffer.concat(chunks).toString('utf8');
        body = body.replace('</head>', POLYFILLS_SCRIPT + '\n</head>');
        delete headers['content-length'];
        res.writeHead(proxyRes.statusCode, headers);
        res.end(body);
      });
    } else if (contentType.includes('javascript')) {
      // Transpile JS to Chrome 70 syntax so older MFD browsers handle ??, ?., etc.
      const chunks = [];
      proxyRes.on('data', chunk => chunks.push(chunk));
      proxyRes.on('end', async () => {
        const source = Buffer.concat(chunks).toString('utf8');
        try {
          const result = await esbuild.transform(source, { target: 'chrome70', loader: 'js' });
          delete headers['content-length'];
          res.writeHead(proxyRes.statusCode, headers);
          res.end(result.code);
          console.log(`  Transpiled ${req.url} (${source.length} -> ${result.code.length} bytes)`);
        } catch (err) {
          console.error(`  esbuild failed for ${req.url}:`, err.message);
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
    console.error(`Proxy error [${req.method} ${req.url}]:`, err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    }
  });

  req.pipe(proxyReq);
});

// Forward WebSocket connections (anchor alarm may use these for live data)
server.on('upgrade', (req, socket, head) => {
  const wsHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!STRIP_REQUEST_HEADERS.has(k.toLowerCase())) {
      wsHeaders[k] = v;
    }
  }
  wsHeaders.host = targetParsed.host;

  const options = {
    hostname: targetParsed.hostname,
    port: parseInt(targetParsed.port) || 80,
    path: req.url,
    headers: wsHeaders,
  };

  const proxyReq = http.request(options);
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

server.listen(config.port, '0.0.0.0', () => {
  console.log(`Proxy listening on ${serverUrl}`);
  console.log(`Forwarding to ${targetParsed.origin}, stripping X-Frame-Options/CSP`);
  console.log(`MFD tile URL: ${tileUrl}`);
  console.log(`MFD tile icon: ${iconUrl}`);
});

const buildAnnouncement = () => JSON.stringify({
  Version: '1',
  Source: config.tile.source,
  IP: config.ip,
  FeatureName: config.tile.featureName,
  Text: [
    {
      Language: 'en',
      Name: config.tile.name,
      Description: config.tile.description
    }
  ],
  Icon: iconUrl,
  URL: tileUrl,
  OnlyShowOnClientIP: 'true',
  BrowserPanel: {
    Enable: true,
    ProgressBarEnable: true,
    MenuText: [
      {
        Language: 'en',
        Name: config.tile.name
      }
    ]
  }
});

const publish = () => {
  const msg = buildAnnouncement();
  const socket = dgram.createSocket('udp4');
  socket.once('listening', () => {
    socket.send(msg, PUBLISH_PORT, MULTICAST_GROUP, (err) => {
      socket.close();
      if (err) {
        console.error('Multicast send error:', err.message);
      } else {
        console.log(`Announced tile "${config.tile.name}" -> ${tileUrl}`);
      }
    });
  });
  socket.bind(PUBLISH_PORT, config.ip);
};

publish();
setInterval(publish, PUBLISH_INTERVAL);
