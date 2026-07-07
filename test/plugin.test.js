// Tests for the Signal K plugin surface: the factory export, the object it
// returns, and the configuration schema the admin UI renders from.
const { test } = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../index.js');

function mockApp() {
  return {
    config: { settings: {} },
    debug() {},
    error() {},
    setPluginStatus() {},
    handleMessage() {},
  };
}

test('module exports a plugin factory and pure internal helpers', () => {
  assert.equal(typeof plugin, 'function');
  assert.equal(typeof plugin.internal, 'object');
  for (const name of [
    'getLocalIp',
    'getServerPort',
    'buildAnnouncement',
    'buildAppModel',
    'buildAllowedPrefixes',
    'isPathAllowed',
  ]) {
    assert.equal(typeof plugin.internal[name], 'function', `internal.${name} should be a function`);
  }
});

test('buildAllowedPrefixes always includes /signalk and the launcher, plus enabled apps', () => {
  const { buildAllowedPrefixes } = plugin.internal;

  // No apps: just the fixed prefixes.
  assert.deepEqual(buildAllowedPrefixes([]), ['/signalk', '/signalk-navico-embedder']);

  // App paths are normalized to a trailing-slash-free prefix; blank/root urls are
  // dropped so they can't collapse the allowlist into allow-all.
  const prefixes = buildAllowedPrefixes([
    { url: '/@signalk/freeboard-sk/' },
    { url: 'admin/' },
    { url: '/' },
    { url: '' },
    { url: undefined },
  ]);
  assert.deepEqual(prefixes, [
    '/signalk',
    '/signalk-navico-embedder',
    '/@signalk/freeboard-sk',
    '/admin',
  ]);
});

test('isPathAllowed matches by path segment, not string prefix', () => {
  const { isPathAllowed } = plugin.internal;
  const prefixes = ['/signalk', '/signalk-navico-embedder', '/admin'];

  // Exact match and any sub-path under an allowed prefix.
  assert.equal(isPathAllowed('/signalk', prefixes), true);
  assert.equal(isPathAllowed('/signalk/v1/api/vessels/self', prefixes), true);
  assert.equal(isPathAllowed('/admin/', prefixes), true);
  assert.equal(isPathAllowed('/admin/#/security', prefixes), true);
  // Query strings are ignored when matching.
  assert.equal(isPathAllowed('/signalk/v1/stream?token=x', prefixes), true);

  // A path that only shares the prefix string is not a sub-path.
  assert.equal(isPathAllowed('/signalkfoo', prefixes), false);
  assert.equal(isPathAllowed('/administer', prefixes), false);
  // Nothing outside the allowlist.
  assert.equal(isPathAllowed('/', prefixes), false);
  assert.equal(isPathAllowed('/skServer/webapps', prefixes), false);
  assert.equal(isPathAllowed('/plugins/foo', prefixes), false);
});

test('isPathAllowed resolves traversal before matching', () => {
  const { isPathAllowed } = plugin.internal;
  const prefixes = ['/signalk'];

  // Encoded and raw traversal that escapes the allowed prefix is refused.
  assert.equal(isPathAllowed('/signalk/%2e%2e/admin/', prefixes), false);
  assert.equal(isPathAllowed('/signalk/../admin', prefixes), false);
  // Traversal that stays within the prefix is still fine.
  assert.equal(isPathAllowed('/signalk/v1/../v1/api', prefixes), true);
  // Malformed percent-encoding is rejected rather than guessed.
  assert.equal(isPathAllowed('/signalk/%zz', prefixes), false);
});

test('the factory returns the Signal K plugin interface', () => {
  const p = plugin(mockApp());
  assert.equal(p.id, 'signalk-navico-embedder');
  assert.equal(p.name, 'Navico MFD Embedder');
  assert.equal(typeof p.description, 'string');
  assert.equal(typeof p.start, 'function');
  assert.equal(typeof p.stop, 'function');
});

test('the config schema declares the documented options', () => {
  const { schema } = plugin(mockApp());
  assert.equal(schema.type, 'object');

  const props = schema.properties;
  assert.deepEqual(props.mode.enum, ['individual', 'launcher']);
  assert.deepEqual(props.mode.enumNames, ['Individual Apps', 'Launcher']);
  assert.equal(props.mode.default, 'individual');
  assert.equal(props.port.type, 'number');
  assert.equal(props.port.default, 8080);
  assert.equal(props.serverPort.type, 'number');
  assert.equal(props.ip.type, 'string');
  assert.equal(props.skToken.type, 'string');
  assert.equal(props.apps.type, 'array');
});

test('each app entry requires a url and exposes the editable fields', () => {
  const { schema } = plugin(mockApp());
  const item = schema.properties.apps.items;

  assert.equal(item.type, 'object');
  assert.deepEqual(item.required, ['url']);
  for (const field of ['enabled', 'url', 'label', 'description']) {
    assert.ok(item.properties[field], `apps.items should expose ${field}`);
  }
  assert.equal(item.properties.enabled.type, 'boolean');
  assert.equal(item.properties.enabled.default, true);
  assert.equal(item.properties.url.type, 'string');
});

test('getLocalIp returns a dotted IPv4 address', () => {
  assert.match(plugin.internal.getLocalIp(), /^\d{1,3}(\.\d{1,3}){3}$/);
});
