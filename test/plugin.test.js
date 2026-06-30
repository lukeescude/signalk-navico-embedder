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
  for (const name of ['getLocalIp', 'getServerPort', 'buildAnnouncement', 'buildAppModel']) {
    assert.equal(typeof plugin.internal[name], 'function', `internal.${name} should be a function`);
  }
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
