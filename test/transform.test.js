// Unit tests for the pure config-transform helpers exposed on the plugin
// factory's `internal` property. These have no I/O — no HTTP, no UDP.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const { internal } = require('../index.js');
const {
  getServerPort,
  buildAnnouncement,
  buildAppModel,
  FALLBACK_ICON_ROUTE,
  LAUNCHER_PATH,
} = internal;

// Run a function with process.env.PORT set to a known value (or removed), then
// restore whatever was there before — env is global and shared across tests.
function withPortEnv(value, fn) {
  const prev = process.env.PORT;
  if (value === undefined) {
    delete process.env.PORT;
  } else {
    process.env.PORT = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env.PORT;
    } else {
      process.env.PORT = prev;
    }
  }
}

test('getServerPort prefers an explicit serverPort override', () => {
  const app = { config: { settings: { port: 3000 } } };
  withPortEnv('5005', () => {
    assert.equal(getServerPort(app, { serverPort: 4321 }), 4321);
  });
});

test('getServerPort falls back to the PORT env var', () => {
  const app = { config: { settings: { port: 3000 } } };
  withPortEnv('5005', () => {
    assert.equal(getServerPort(app, {}), 5005);
  });
});

test('getServerPort falls back to the server settings port', () => {
  const app = { config: { settings: { port: 3001 } } };
  withPortEnv(undefined, () => {
    assert.equal(getServerPort(app, {}), 3001);
  });
});

test('getServerPort defaults to 3000', () => {
  withPortEnv(undefined, () => {
    assert.equal(getServerPort({ config: { settings: {} } }, {}), 3000);
    assert.equal(getServerPort({ config: {} }, undefined), 3000);
  });
});

test('buildAnnouncement produces the MFD announcement payload', () => {
  const tile = {
    label: 'Freeboard',
    description: 'Chartplotter',
    tileUrl: 'http://1.2.3.4:8080/fb/',
    iconUrl: 'http://1.2.3.4:8080/fb/icon.png',
  };
  const msg = JSON.parse(buildAnnouncement('1.2.3.4', tile));

  assert.equal(msg.Version, '1');
  assert.equal(msg.Source, 'signalk-navico-embedder');
  assert.equal(msg.IP, '1.2.3.4');
  assert.equal(msg.FeatureName, 'Freeboard');
  assert.deepEqual(msg.Text, [{ Language: 'en', Name: 'Freeboard', Description: 'Chartplotter' }]);
  assert.equal(msg.Icon, tile.iconUrl);
  assert.equal(msg.URL, tile.tileUrl);
  assert.equal(msg.OnlyShowOnClientIP, 'true');
  assert.equal(msg.BrowserPanel.Enable, true);
  assert.equal(msg.BrowserPanel.ProgressBarEnable, true);
  assert.deepEqual(msg.BrowserPanel.MenuText, [{ Language: 'en', Name: 'Freeboard' }]);
});

test('buildAppModel drops disabled and url-less apps', () => {
  const model = buildAppModel({
    apps: [
      { enabled: true, url: '/a/' },
      { enabled: false, url: '/b/' }, // disabled
      { url: '/c/' }, // enabled defaults to true
      { enabled: true }, // no url
      null, // junk
    ],
  }, '10.0.0.1', 8080);

  assert.equal(model.enabledApps.length, 2);
  assert.deepEqual(model.apps.map((t) => t.tileUrl), [
    'http://10.0.0.1:8080/a/',
    'http://10.0.0.1:8080/c/',
  ]);
});

test('buildAppModel normalizes paths and resolves icon URLs', () => {
  const model = buildAppModel({
    apps: [
      { enabled: true, url: 'noslash' }, // path gets a leading slash, bundled fallback icon
      { enabled: true, url: '/abs/', icon: '/custom/icon.png' }, // server-relative icon
      { enabled: true, url: '/ext/', icon: 'https://cdn.example/x.png' }, // absolute icon untouched
      { enabled: true, url: '/rel/', icon: 'rel.png' }, // relative icon gets a leading slash
    ],
  }, '10.0.0.1', 8080);
  const [a, b, c, d] = model.apps;

  assert.equal(a.tileUrl, 'http://10.0.0.1:8080/noslash');
  assert.equal(a.iconUrl, `http://10.0.0.1:8080${FALLBACK_ICON_ROUTE}`);
  assert.equal(b.iconUrl, 'http://10.0.0.1:8080/custom/icon.png');
  assert.equal(c.iconUrl, 'https://cdn.example/x.png');
  assert.equal(d.iconUrl, 'http://10.0.0.1:8080/rel.png');
});

test('buildAppModel falls back to the path for a missing label', () => {
  const model = buildAppModel({ apps: [{ enabled: true, url: '/x/' }] }, '10.0.0.1', 8080);
  assert.equal(model.apps[0].label, '/x/');
  assert.equal(model.apps[0].description, '');
});

test('buildAppModel builds server-relative webapps for the chooser', () => {
  const model = buildAppModel({
    apps: [
      { enabled: true, url: 'foo', label: 'Foo', description: 'D', icon: '/i.png' },
      { enabled: true, url: '/bar/', icon: 'https://cdn.example/b.png' },
      { enabled: false, url: '/hidden/' },
    ],
  }, '10.0.0.1', 8080);

  assert.equal(model.webapps.length, 2);
  assert.deepEqual(model.webapps[0], { name: 'Foo', url: '/foo', icon: '/i.png', description: 'D' });
  assert.deepEqual(model.webapps[1], {
    name: '/bar/',
    url: '/bar/',
    icon: 'https://cdn.example/b.png',
    description: '',
  });
});

test('buildAppModel announces a single launcher tile in launcher mode', () => {
  const model = buildAppModel({
    mode: 'launcher',
    apps: [{ enabled: true, url: '/a/' }, { enabled: true, url: '/b/' }],
  }, '10.0.0.1', 8080);

  assert.equal(model.mode, 'launcher');
  assert.equal(model.apps.length, 1);
  assert.equal(model.apps[0].label, 'SignalK Webapps');
  assert.equal(model.apps[0].tileUrl, `http://10.0.0.1:8080${LAUNCHER_PATH}`);
  // The chooser still lists every enabled app, even though only one tile is announced.
  assert.equal(model.webapps.length, 2);
});

test('buildAppModel defaults to individual mode for missing/unknown modes', () => {
  assert.equal(buildAppModel({ apps: [] }, '1.1.1.1', 80).mode, 'individual');
  assert.equal(buildAppModel({ mode: 'nonsense', apps: [] }, '1.1.1.1', 80).mode, 'individual');
});

test('buildAppModel tolerates a missing apps array', () => {
  const model = buildAppModel({}, '1.1.1.1', 80);
  assert.deepEqual(model.apps, []);
  assert.deepEqual(model.webapps, []);
  assert.deepEqual(model.enabledApps, []);
});
