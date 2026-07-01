// Integration tests that exercise the running proxy: header rewriting, body
// injection, JS transpilation, the local icon route, and the start/stop
// lifecycle (status reporting, the webapps delta, and UDP tile announcements).
//
// The real UDP multicast is replaced with a stub (see fakeDgram) so the tests
// never bind the multicast port (2053) or emit packets — they just capture what
// the plugin would have announced. Each test runs its own backend HTTP server
// and proxy on fresh ephemeral ports; tests in a file run sequentially.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const dgram = require('node:dgram');

const plugin = require('../index.js');
const { FALLBACK_ICON_ROUTE, LAUNCHER_PATH } = plugin.internal;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Bind an ephemeral port, then release it so a fresh server can claim it.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// A backend HTTP server standing in for the local Signal K server. It records
// every request it receives so tests can assert on forwarded headers.
function startBackend(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, requests }));
  });
}

function httpGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, headers, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });
}

// Poll the proxy's local icon route until it answers — confirms the HTTP server
// is accepting connections without depending on the backend being reachable.
async function waitForProxy(port) {
  for (let i = 0; i < 100; i++) {
    try {
      await httpGet(port, FALLBACK_ICON_ROUTE);
      return;
    } catch {
      await delay(20);
    }
  }
  throw new Error('proxy never started listening');
}

async function waitForProxyDown(port) {
  for (let i = 0; i < 100; i++) {
    try {
      await httpGet(port, FALLBACK_ICON_ROUTE);
      await delay(20);
    } catch {
      return true;
    }
  }
  return false;
}

function mockApp() {
  const calls = { debug: [], error: [], status: [], messages: [] };
  return {
    config: { settings: {} },
    debug: (m) => calls.debug.push(m),
    error: (m) => calls.error.push(m),
    setPluginStatus: (m) => calls.status.push(m),
    handleMessage: (id, delta) => calls.messages.push({ id, delta }),
    calls,
  };
}

// Replace dgram.createSocket with a stub that records sends instead of touching
// the network. index.js captured the same module object, so this intercepts it.
function fakeDgram() {
  const sent = [];
  const original = dgram.createSocket;
  dgram.createSocket = () => {
    let onListening = null;
    return {
      once(event, cb) {
        if (event === 'listening') onListening = cb;
        return this;
      },
      on() {
        return this;
      },
      bind() {
        if (onListening) setImmediate(onListening);
      },
      send(message, port, group, cb) {
        sent.push({ message: message.toString(), port, group });
        if (cb) cb(null);
      },
      close() {},
    };
  };
  return {
    sent,
    restore() {
      dgram.createSocket = original;
    },
  };
}

// Start a backend + proxy on fresh ports and return handles plus a cleanup fn.
// Defaults to no announced apps so the UDP path stays dormant unless a test
// opts in via `options.apps`.
async function setup({ handler, options = {} } = {}) {
  const backend = await startBackend(handler || ((req, res) => res.end('ok')));
  const proxyPort = await freePort();
  const app = mockApp();
  const p = plugin(app);
  const dg = fakeDgram();

  p.start({ ip: '127.0.0.1', port: proxyPort, serverPort: backend.port, apps: [], ...options });
  await waitForProxy(proxyPort);
  // Let the (stubbed) announcement fire — bind schedules it via setImmediate.
  await delay(20);

  return {
    app,
    backend,
    proxyPort,
    sent: dg.sent,
    get: (path, headers) => httpGet(proxyPort, path, headers),
    async cleanup() {
      p.stop();
      dg.restore();
      await new Promise((resolve) => backend.server.close(resolve));
    },
  };
}

test('serves the bundled fallback icon from a local route', async () => {
  const ctx = await setup();
  try {
    const res = await ctx.get(FALLBACK_ICON_ROUTE);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /^image\//);
    assert.match(res.headers['cache-control'], /max-age=3600/);
    assert.ok(res.body.length > 0);
    // Served by the plugin itself — never proxied to the backend.
    assert.equal(ctx.backend.requests.length, 0);
  } finally {
    await ctx.cleanup();
  }
});

test('injects polyfills and the auth token into proxied HTML', async () => {
  const html = '<html><head><title>t</title></head><body>x</body></html>';
  const ctx = await setup({
    options: { skToken: 'tok-123' },
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(html);
    },
  });
  try {
    const res = await ctx.get('/', { 'if-none-match': '"abc"', 'accept-encoding': 'gzip' });

    assert.equal(res.status, 200);
    assert.ok(res.body.includes('Object.fromEntries'), 'polyfill script injected');
    assert.ok(res.body.includes('window.SK_TOKEN="tok-123"'), 'token script injected');
    // Injected before </head> so it runs before the app's own scripts.
    assert.ok(res.body.indexOf('Object.fromEntries') < res.body.indexOf('</head>'));
    // Body was rewritten, so the upstream content-length must be dropped.
    assert.equal(res.headers['content-length'], undefined);

    const forwarded = ctx.backend.requests.at(-1).headers;
    assert.equal(forwarded.host, `127.0.0.1:${ctx.backend.port}`);
    assert.equal(forwarded.authorization, 'Bearer tok-123');
    assert.equal(forwarded['if-none-match'], undefined, 'conditional header stripped');
    assert.equal(forwarded['accept-encoding'], undefined, 'accept-encoding stripped');
  } finally {
    await ctx.cleanup();
  }
});

test('omits the token script when no token is configured', async () => {
  const ctx = await setup({
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><head></head><body></body></html>');
    },
  });
  try {
    const res = await ctx.get('/');
    assert.ok(res.body.includes('Object.fromEntries'));
    assert.ok(!res.body.includes('SK_TOKEN'), 'no token script without a token');
  } finally {
    await ctx.cleanup();
  }
});

test('transpiles modern JavaScript for the MFD old Chromium', async () => {
  const source = 'function pick(o) { return o?.deep?.value ?? "default"; }';
  const ctx = await setup({
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      res.end(source);
    },
  });
  try {
    const res = await ctx.get('/bundle.js');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /javascript/);
    assert.ok(res.body.includes('pick'), 'identifiers preserved');
    // Optional chaining is unsupported in the target Chromium and must be lowered.
    assert.ok(!res.body.includes('?.'), 'optional chaining transpiled away');
  } finally {
    await ctx.cleanup();
  }
});

test('downlevels modern CSS for the MFD old Chromium', async () => {
  const source = '@layer base { h1 { color: oklch(0.7 0.15 30); } }';
  const ctx = await setup({
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'text/css' });
      res.end(source);
    },
  });
  try {
    const res = await ctx.get('/bundle.css');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /css/);
    assert.ok(res.body.includes('h1'), 'rules preserved');
    // @layer is unsupported and dropped wholesale by the target Chromium, which
    // would silently delete the reset/base styles wrapped in it; must be unwrapped.
    assert.ok(!res.body.includes('@layer'), 'cascade layer unwrapped');
    // oklch() is unsupported; an rgb() fallback must be emitted ahead of it.
    assert.match(res.body, /rgb\(/i, 'oklch color has an rgb fallback');
  } finally {
    await ctx.cleanup();
  }
});

test('strips framing headers from the proxied response', async () => {
  const ctx = await setup({
    handler: (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/plain',
        'x-frame-options': 'DENY',
        'content-security-policy': 'default-src \'none\'',
        'content-security-policy-report-only': 'report',
      });
      res.end('hi');
    },
  });
  try {
    const res = await ctx.get('/');
    assert.equal(res.body, 'hi');
    assert.equal(res.headers['x-frame-options'], undefined);
    assert.equal(res.headers['content-security-policy'], undefined);
    assert.equal(res.headers['content-security-policy-report-only'], undefined);
  } finally {
    await ctx.cleanup();
  }
});

test('rewrites redirect Location headers to the proxy origin', async () => {
  const ctx = await setup({
    handler: (req, res) => {
      // req.headers.host is the target origin the proxy forwarded to.
      res.writeHead(302, { 'location': `http://${req.headers.host}/after`, 'content-type': 'text/plain' });
      res.end();
    },
  });
  try {
    const res = await ctx.get('/go');
    assert.equal(res.status, 302);
    assert.equal(res.headers.location, `http://127.0.0.1:${ctx.proxyPort}/after`);
  } finally {
    await ctx.cleanup();
  }
});

test('passes non-text content through unchanged', async () => {
  const ctx = await setup({
    handler: (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"x":1}');
    },
  });
  try {
    const res = await ctx.get('/data');
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /application\/json/);
    assert.equal(res.body, '{"x":1}');
  } finally {
    await ctx.cleanup();
  }
});

test('returns 502 when the Signal K server is unreachable', async () => {
  const deadPort = await freePort(); // freed immediately, so connections are refused
  const proxyPort = await freePort();
  const app = mockApp();
  const p = plugin(app);
  const dg = fakeDgram();
  p.start({ ip: '127.0.0.1', port: proxyPort, serverPort: deadPort, apps: [] });
  try {
    await waitForProxy(proxyPort);
    const res = await httpGet(proxyPort, '/');
    assert.equal(res.status, 502);
    assert.ok(res.body.startsWith('Proxy error'));
  } finally {
    p.stop();
    dg.restore();
  }
});

test('publishes the webapps delta and announces a tile per enabled app', async () => {
  const ctx = await setup({
    options: {
      apps: [
        { enabled: true, url: '/foo/', label: 'Foo', description: 'desc' },
        { enabled: false, url: '/bar/' },
        { enabled: true, url: '/baz/', label: 'Baz' },
      ],
    },
  });
  try {
    // Webapps delta published to the data model for the standalone chooser.
    const delta = ctx.app.calls.messages.at(-1);
    assert.equal(delta.id, 'signalk-navico-embedder');
    const value = delta.delta.updates[0].values[0];
    assert.equal(value.path, 'plugins.signalk-navico-embedder.webapps');
    assert.equal(value.value.length, 2);
    assert.deepEqual(value.value[0], { name: 'Foo', url: '/foo/', icon: '', description: 'desc' });

    // One UDP announcement per enabled app, addressed to the multicast group.
    assert.equal(ctx.sent.length, 2);
    assert.equal(ctx.sent[0].port, 2053);
    assert.equal(ctx.sent[0].group, '239.2.1.1');
    const announced = JSON.parse(ctx.sent[0].message);
    assert.equal(announced.FeatureName, 'Foo');
    assert.equal(announced.URL, `http://127.0.0.1:${ctx.proxyPort}/foo/`);

    assert.ok(ctx.app.calls.status.at(-1).includes('Announcing 2 tile(s)'));
  } finally {
    await ctx.cleanup();
  }
});

test('reports an idle status and announces nothing when no apps are enabled', async () => {
  const ctx = await setup();
  try {
    assert.equal(ctx.sent.length, 0);
    assert.ok(ctx.app.calls.status.at(-1).includes('no apps configured'));

    const delta = ctx.app.calls.messages.at(-1);
    assert.deepEqual(delta.delta.updates[0].values[0].value, []);
  } finally {
    await ctx.cleanup();
  }
});

test('announces a single launcher tile in launcher mode', async () => {
  const ctx = await setup({
    options: {
      mode: 'launcher',
      apps: [{ enabled: true, url: '/foo/' }, { enabled: true, url: '/bar/' }],
    },
  });
  try {
    assert.equal(ctx.sent.length, 1);
    const announced = JSON.parse(ctx.sent[0].message);
    assert.equal(announced.FeatureName, 'SignalK Webapps');
    assert.equal(announced.URL, `http://127.0.0.1:${ctx.proxyPort}${LAUNCHER_PATH}`);
    assert.ok(ctx.app.calls.status.at(-1).includes('app launcher'));

    // The chooser delta still advertises every enabled app.
    const delta = ctx.app.calls.messages.at(-1);
    assert.equal(delta.delta.updates[0].values[0].value.length, 2);
  } finally {
    await ctx.cleanup();
  }
});

test('stop() shuts the server down and reports stopped', async () => {
  const backend = await startBackend((req, res) => res.end('ok'));
  const proxyPort = await freePort();
  const app = mockApp();
  const p = plugin(app);
  const dg = fakeDgram();
  p.start({ ip: '127.0.0.1', port: proxyPort, serverPort: backend.port, apps: [] });
  await waitForProxy(proxyPort);

  p.stop();
  dg.restore();
  try {
    assert.equal(app.calls.status.at(-1), 'Stopped');
    assert.ok(await waitForProxyDown(proxyPort), 'proxy stopped accepting connections');
  } finally {
    await new Promise((resolve) => backend.server.close(resolve));
  }
});
