'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const origin = 'https://viewblock.test';
const key = 'viewblock.site:' + origin;
const sender = { id: 'viewblock-test', tab: { id: 7 }, frameId: 0, url: origin + '/inbox' };
const descriptor = {
  selector: '#old-block', tag: 'div', fragile: false,
  relative: {
    tag: 'div', path: [],
    before: { selector: '#toolbar', tag: 'section', distance: 1 },
    after: { selector: '#messages', tag: 'section', distance: 1 }
  }
};

function worker(initial = {}) {
  const storage = structuredClone(initial), scripts = [];
  let listener;
  const event = { addListener() {} };
  const chrome = {
    runtime: {
      id: sender.id, getURL: file => 'chrome-extension://viewblock-test/' + file,
      onMessage: { addListener(callback) { listener = callback; } }, onInstalled: event, onStartup: event
    },
    storage: { local: {
      async get(name) { return structuredClone(name === null ? storage : { [name]: storage[name] }); },
      async set(data) { Object.assign(storage, structuredClone(data)); },
      async remove(name) { delete storage[name]; }
    } },
    permissions: { async contains() { return true; }, onRemoved: event },
    scripting: {
      async getRegisteredContentScripts({ ids } = {}) { return scripts.filter(script => !ids || ids.includes(script.id)); },
      async registerContentScripts(values) { scripts.push(...structuredClone(values)); }
    }
  };
  const context = vm.createContext({ chrome, URL, TextEncoder, console, importScripts() {} });
  vm.runInContext(readFileSync(path.join(root, 'core.js'), 'utf8'), context);
  vm.runInContext(readFileSync(path.join(root, 'background.js'), 'utf8'), context);
  return {
    storage,
    async send(message, from = sender) {
      return JSON.parse(JSON.stringify(await new Promise(resolve => listener(message, from, resolve))));
    }
  };
}

test('background handshake matches the manifest and all component protocols', async () => {
  const result = await worker().send({ type: 'VB_HEALTH' });
  assert.equal(result.ok, true);
  assert.equal(result.version, JSON.parse(readFileSync(path.join(root, 'manifest.json'))).version);
  assert.ok(result.capabilities.includes('relativeHiding'));
  for (const file of ['content.js', 'popup.js']) {
    const protocol = Number(readFileSync(path.join(root, file), 'utf8').match(/const PROTOCOL = (\d+)/)[1]);
    assert.equal(result.protocol, protocol, file);
  }
});

test('VB_SAVE retains neighbor anchors across actual storage writes and worker restarts', async () => {
  const first = worker();
  const saved = await first.send({ type: 'VB_SAVE', mode: 'hide', selections: [descriptor] });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.profile.selections[0], descriptor);
  assert.deepEqual(first.storage[key].modes.hide.selections[0], descriptor);
  const restarted = worker(first.storage);
  const activated = await restarted.send({ type: 'VB_PAGE_ACTIVATE_MODE', mode: 'hide' });
  assert.deepEqual(activated.profile.selections[0], descriptor);
});

test('saving and activating keep retains the independent hide anchors', async () => {
  const current = worker();
  await current.send({ type: 'VB_SAVE', mode: 'hide', selections: [descriptor] });
  const keep = { selector: '#messages', tag: 'section', fragile: false };
  const saved = await current.send({ type: 'VB_SAVE', mode: 'keep', selections: [keep] });
  assert.deepEqual(saved.profile.modes.hide.selections, [descriptor]);
  assert.deepEqual(saved.profile.selections, [keep]);
  const restored = await current.send({ type: 'VB_PAGE_ACTIVATE_MODE', mode: 'hide' });
  assert.deepEqual(restored.profile.selections, [descriptor]);
  assert.deepEqual(restored.profile.modes.keep.selections, [keep]);
});

test('VB_SAVE retains grid coordinates and structural guards across a worker restart', async () => {
  const current = worker();
  const withGrid = { ...descriptor, grid: {
    container: { selector: '#dashboard', tag: 'main' }, tag: 'div',
    row: 3, column: 4, rows: 3, columns: 4, count: 12, shape: 'div:1(h2:0())', path: []
  } };
  const saved = await current.send({ type: 'VB_SAVE', mode: 'hide', selections: [withGrid] });
  assert.equal(saved.ok, true);
  assert.deepEqual(saved.profile.selections[0], withGrid);
  const restarted = worker(current.storage);
  const restored = await restarted.send({ type: 'VB_PAGE_ACTIVATE_MODE', mode: 'hide' });
  assert.deepEqual(restored.profile.selections[0], withGrid);
});

test('legacy profiles without anchors still activate and pause', async () => {
  const legacy = { selector: '#old-block', tag: 'div', fragile: false };
  const current = worker({ [key]: { version: 2, mode: 'hide', enabled: true, selections: [legacy] } });
  const paused = await current.send({ type: 'VB_PAGE_TOGGLE', enabled: false });
  assert.equal(paused.profile.enabled, false);
  assert.deepEqual(paused.profile.selections, [legacy]);
  const activated = await current.send({ type: 'VB_PAGE_ACTIVATE_MODE', mode: 'hide' });
  assert.equal(activated.profile.enabled, true);
  assert.deepEqual(activated.profile.selections, [legacy]);
});

test('malformed optional anchors cannot invalidate a valid saved selector', async () => {
  const current = worker();
  const invalid = structuredClone(descriptor);
  invalid.relative.before.distance = -1;
  invalid.unexpected = 'not persisted';
  const result = await current.send({ type: 'VB_SAVE', mode: 'hide', selections: [invalid] });
  assert.equal(result.ok, true);
  assert.deepEqual(result.profile.selections, [{ selector: descriptor.selector, tag: descriptor.tag, fragile: false }]);
});

test('concurrent saves from two tabs preserve both mode banks', async () => {
  const current = worker();
  const keep = { selector: '#messages', tag: 'section', fragile: false };
  const responses = await Promise.all([
    current.send({ type: 'VB_SAVE', mode: 'hide', selections: [descriptor] }),
    current.send({ type: 'VB_SAVE', mode: 'keep', selections: [keep] }, { ...sender, tab: { id: 8 } })
  ]);
  assert.ok(responses.every(response => response.ok));
  assert.deepEqual(current.storage[key].modes.hide.selections, [descriptor]);
  assert.deepEqual(current.storage[key].modes.keep.selections, [keep]);
});
