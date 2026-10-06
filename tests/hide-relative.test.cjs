'use strict';

const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const { existsSync, readdirSync, readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const path = require('node:path');

// No extension/runtime dependencies are added to the project. Use a local
// Playwright installation, NODE_PATH, or the desktop app's bundled runtime.
function loadPlaywright() {
  const candidates = [process.env.VIEWBLOCK_PLAYWRIGHT_MODULE, 'playwright',
    path.join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright')];
  for (const candidate of candidates.filter(Boolean)) {
    try { return require(candidate); } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') throw error;
    }
  }
  throw new Error('Playwright is required. Set NODE_PATH or VIEWBLOCK_PLAYWRIGHT_MODULE to its installed module path.');
}

function chromiumExecutable() {
  if (process.env.VIEWBLOCK_CHROMIUM) return process.env.VIEWBLOCK_CHROMIUM;
  if (process.platform !== 'win32') return undefined;
  const cache = path.join(process.env.LOCALAPPDATA || path.join(homedir(), 'AppData/Local'), 'ms-playwright');
  if (!existsSync(cache)) return undefined;
  for (const name of readdirSync(cache).filter(name => /^chromium_headless_shell-\d+$/.test(name)).sort().reverse()) {
    const executable = path.join(cache, name, 'chrome-headless-shell-win64/chrome-headless-shell.exe');
    if (existsSync(executable)) return executable;
  }
  return undefined;
}

let browser;
const corePath = path.join(__dirname, '../core.js');
const contentPath = path.join(__dirname, '../content.js');
before(async () => {
  browser = await loadPlaywright().chromium.launch({ headless: true, executablePath: chromiumExecutable() });
  console.log('Browser: Chromium ' + browser.version());
});
after(async () => { await browser?.close(); });

async function withPage(html, run) {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.route('http://127.0.0.1/viewblock-test', route => route.fulfill({
      contentType: 'text/html', body: `<!doctype html><html><body>${html}</body></html>`
    }));
    await page.goto('http://127.0.0.1/viewblock-test');
    await page.addScriptTag({ path: corePath });
    await run(page);
    assert.deepEqual(errors, [], 'No uncaught errors in browser code');
  } finally { await page.close(); }
}

const betweenAnchors = '<main><div id="toolbar">Toolbar</div><div id="advert-old">Advert</div><div id="inbox">Inbox</div></main>';

test('hide: a changed own identifier resolves between two stable neighbors', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.id = 'advert-new';
      return { relative: Boolean(item.relative?.before && item.relative?.after),
        found: C.resolveSelection(item, document, 'hide') === target,
        defaultFound: C.resolveSelection(item) !== null };
    });
    assert.deepEqual(result, { relative: true, found: true, defaultFound: false });
  });
});

test('hide: replacement DOM is recovered after a saved profile round trip and page reload', async () => {
  await withPage(betweenAnchors, async page => {
    const saved = await page.evaluate(() => {
      const C = ViewBlockCore, item = C.describeElement(document.getElementById('advert-old'), document, 'hide');
      return JSON.parse(JSON.stringify(C.saveMode(null, 'hide', [item], 100)));
    });
    await page.route('http://127.0.0.1/viewblock-test', route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><main><div id="toolbar">Toolbar</div><div id="advert-reloaded">New advert</div><div id="inbox">Inbox</div></main>'
    }));
    await page.reload();
    await page.addScriptTag({ path: corePath });
    const result = await page.evaluate(saved => {
      const C = ViewBlockCore, normalized = C.normalizeProfile(saved), item = normalized.selections[0];
      return { same: JSON.stringify(item.relative) === JSON.stringify(saved.selections[0].relative),
        id: C.resolveSelection(item, document, 'hide')?.id };
    }, saved);
    assert.deepEqual(result, { same: true, id: 'advert-reloaded' });
  });
});

for (const side of ['before', 'after']) {
  test(`hide: one stable ${side} neighbor recovers a renamed edge block`, async () => {
    const html = side === 'before'
      ? '<main><div id="toolbar">Toolbar</div><div id="advert-old">Advert</div></main>'
      : '<main><div id="advert-old">Advert</div><div id="inbox">Inbox</div></main>';
    await withPage(html, async page => {
      const result = await page.evaluate(side => {
        const C = ViewBlockCore, target = document.getElementById('advert-old');
        const item = C.describeElement(target, document, 'hide');
        target.id = 'advert-new';
        return { anchored: Boolean(item.relative?.[side]), found: C.resolveSelection(item, document, 'hide') === target };
      }, side);
      assert.deepEqual(result, { anchored: true, found: true });
    });
  });
}

test('hide: insertion before the anchored region does not shift a positional selection', async () => {
  await withPage('<main><div id="toolbar">Toolbar</div><div>Advert</div><div id="inbox">Inbox</div></main>', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.querySelector('main').children[1];
      const item = C.describeElement(target, document, 'hide');
      const unrelated = document.createElement('div'); unrelated.textContent = 'New leading block';
      document.querySelector('main').prepend(unrelated);
      return { fragile: item.fragile, staleSelector: document.querySelector(item.selector)?.id,
        found: C.resolveSelection(item, document, 'hide') === target };
    });
    assert.equal(result.fragile, true);
    assert.equal(result.staleSelector, 'toolbar');
    assert.equal(result.found, true);
  });
});

test('hide: anchors on an ancestor recover its nested target after replacement', async () => {
  await withPage('<main><header id="toolbar">Toolbar</header><section id="wrapper-old"><div><span>Caption</span><div id="advert-old">Advert</div></div></section><footer id="inbox">Inbox</footer></main>', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, item = C.describeElement(document.getElementById('advert-old'), document, 'hide');
      document.getElementById('wrapper-old').outerHTML = '<section id="wrapper-new"><div><span>New caption</span><div id="advert-new">New advert</div></div></section>';
      return { hasPath: item.relative?.path?.length > 0, id: C.resolveSelection(item, document, 'hide')?.id };
    });
    assert.deepEqual(result, { hasPath: true, id: 'advert-new' });
  });
});

test('hide: an unchanged unique semantic selector retains priority after moving the block', async () => {
  await withPage(betweenAnchors + '<section id="destination"></section>', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      document.getElementById('destination').append(target);
      return C.resolveSelection(item, document, 'hide') === target;
    });
    assert.equal(result, true);
  });
});

test('hide: disappearing target does not select either stable neighbor', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.remove();
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true);
  });
});

test('hide: a one-sided anchor rejects a missing block instead of hiding the following sibling', async () => {
  await withPage('<main><div id="toolbar">Toolbar</div><div id="advert-old">Advert</div><div>Other block without a hook</div></main>', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.remove();
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true);
  });
});

test('hide: duplicated anchor selectors are rejected', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.id = 'advert-new';
      document.body.insertAdjacentHTML('beforeend', '<section><div id="toolbar">Duplicate toolbar</div><div id="inbox">Duplicate inbox</div></section>');
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true);
  });
});

test('hide: neighbors now belonging to different parents are rejected', async () => {
  await withPage(betweenAnchors + '<section></section>', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.id = 'advert-new'; document.querySelector('section').append(document.getElementById('inbox'));
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true);
  });
});

test('hide: conflicting positions after insertion inside the anchored region are rejected', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.id = 'advert-new'; target.insertAdjacentHTML('beforebegin', '<div>New intervening block</div>');
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true);
  });
});

test('hide: changed descendant structure does not redirect a saved nested selection', async () => {
  await withPage('<main><header id="toolbar">Toolbar</header><section><div><div id="advert-old">Advert</div></div></section><footer id="inbox">Inbox</footer></main>', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.id = 'advert-new'; target.insertAdjacentHTML('beforebegin', '<div>Unrelated new child</div>');
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true);
  });
});

test('hide: scripts, styles and extension helper are excluded from relative positions', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      target.id = 'advert-new';
      target.insertAdjacentHTML('beforebegin', '<style></style><script type="application/json">{}</script><div data-viewblock-ui></div>');
      return C.resolveSelection(item, document, 'hide') === target;
    });
    assert.equal(result, true);
  });
});

test('keep: descriptors and default resolution preserve selector-only behavior', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const keep = C.describeElement(target), hide = C.describeElement(target, document, 'hide');
      target.id = 'advert-new';
      return { keepHasRelative: Object.hasOwn(keep, 'relative'),
        keepMisses: C.resolveSelection(keep, document, 'keep') === null,
        hideInKeepMisses: C.resolveSelection(hide, document, 'keep') === null,
        defaultMisses: C.resolveSelection(hide) === null };
    });
    assert.deepEqual(result, { keepHasRelative: false, keepMisses: true, hideInKeepMisses: true, defaultMisses: true });
  });
});

test('profiles: normalization retains only valid relative data and keeps mode banks independent', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore;
      const hide = C.describeElement(document.getElementById('advert-old'), document, 'hide');
      const keep = C.describeElement(document.getElementById('inbox'));
      const normalized = C.normalizeSelections([{ ...hide, unsavedText: 'must not persist' }]);
      let profile = C.saveMode(null, 'hide', normalized, 100);
      profile = C.saveMode(profile, 'keep', [keep], 200);
      profile = C.normalizeProfile(JSON.parse(JSON.stringify(profile)));
      const active = C.activateMode(profile, 'hide');
      return { relative: Boolean(hide.relative), preserved: JSON.stringify(active.selections[0].relative) === JSON.stringify(hide.relative),
        textRemoved: !Object.hasOwn(active.selections[0], 'unsavedText'), keepSelector: active.modes.keep.selections[0].selector,
        keepHasRelative: Object.hasOwn(active.modes.keep.selections[0], 'relative') };
    });
    assert.deepEqual(result, { relative: true, preserved: true, textRemoved: true, keepSelector: '#inbox', keepHasRelative: false });
  });
});

test('profiles: malformed optional anchors are discarded without losing a valid selector', async () => {
  await withPage(betweenAnchors, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('advert-old');
      const item = C.describeElement(target, document, 'hide');
      item.relative.before.distance = -1;
      const normalized = C.normalizeSelections([item])[0];
      return { noRelative: !Object.hasOwn(normalized, 'relative'), selector: normalized.selector,
        found: C.resolveSelection(normalized, document, 'hide') === target };
    });
    assert.deepEqual(result, { noRelative: true, selector: '#advert-old', found: true });
  });
});

async function installContent(page, profile = null) {
  const protocol = Number(readFileSync(contentPath, 'utf8').match(/const PROTOCOL = (\d+)/)[1]);
  await page.evaluate(({ profile, protocol }) => {
    const storageListeners = [], messageListeners = [];
    const store = { [ViewBlockCore.keyFor(location.origin)]: profile,
      ['viewblock.helper:' + location.origin]: { hidden: true } };
    const originalAttachShadow = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (options) {
      const root = originalAttachShadow.call(this, options);
      if (this.hasAttribute('data-viewblock-ui')) globalThis.testShadow = root;
      return root;
    };
    const local = {
      async get(key) { return { [key]: structuredClone(store[key]) }; },
      async set(data) {
        const changes = {};
        for (const [key, value] of Object.entries(data)) {
          if (JSON.stringify(store[key]) === JSON.stringify(value)) continue;
          changes[key] = { oldValue: structuredClone(store[key]), newValue: structuredClone(value) };
          store[key] = structuredClone(value);
        }
        if (Object.keys(changes).length) for (const listener of storageListeners) listener(changes, 'local');
      }
    };
    globalThis.testStore = store;
    globalThis.chrome = {
      storage: { local, onChanged: { addListener: listener => storageListeners.push(listener) } },
      runtime: {
        id: 'viewblock-test-extension',
        onMessage: { addListener: listener => messageListeners.push(listener) },
        async sendMessage(message) {
          const C = ViewBlockCore, key = C.keyFor(location.origin);
          if (message.type === 'VB_HEALTH') return { ok: true, protocol };
          let profile = C.normalizeProfile(store[key]);
          if (message.type === 'VB_SAVE') profile = C.saveMode(profile, message.mode, message.selections);
          else if (message.type === 'VB_PAGE_ACTIVATE_MODE') profile = C.activateMode(profile, message.mode);
          else if (message.type === 'VB_PAGE_TOGGLE') profile = { ...profile, enabled: message.enabled };
          else throw new Error('Unexpected mocked runtime message: ' + message.type);
          await local.set({ [key]: profile });
          return { ok: true, profile };
        }
      }
    };
    globalThis.testMessage = message => new Promise((resolve, reject) => {
      let accepted = false;
      for (const listener of messageListeners) accepted = listener(message, { id: chrome.runtime.id }, resolve) || accepted;
      if (!accepted) reject(new Error('No content listener accepted ' + message.type));
    });
  }, { profile, protocol });
  await page.addScriptTag({ path: contentPath });
  await page.evaluate(() => testMessage({ type: 'VB_STATUS' }));
}

test('content: saved hide survives identifier change, DOM replacement, and missing target', async () => {
  await withPage(betweenAnchors, async page => {
    const profile = await page.evaluate(() => ViewBlockCore.saveMode(null, 'hide', [
      ViewBlockCore.describeElement(document.getElementById('advert-old'), document, 'hide')
    ]));
    await installContent(page, profile);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('advert-old')).display === 'none');
    await page.evaluate(() => { document.getElementById('advert-old').id = 'advert-renamed'; });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('advert-renamed')).display === 'none');
    await page.evaluate(() => {
      document.getElementById('advert-renamed').outerHTML = '<div id="advert-replaced">Replacement advert</div>';
    });
    await page.waitForFunction(() => getComputedStyle(document.getElementById('advert-replaced')).display === 'none');
    await page.evaluate(() => document.getElementById('advert-replaced').remove());
    await page.waitForFunction(async () => (await testMessage({ type: 'VB_STATUS' })).missing === 1);
    const result = await page.evaluate(() => ['toolbar', 'inbox'].map(id => getComputedStyle(document.getElementById(id)).display));
    assert.deepEqual(result, ['block', 'block']);
  });
});

test('content: editing and saving a replaced hidden block persists its new anchors', async () => {
  await withPage(betweenAnchors, async page => {
    const profile = await page.evaluate(() => ViewBlockCore.saveMode(null, 'hide', [
      ViewBlockCore.describeElement(document.getElementById('advert-old'), document, 'hide')
    ]));
    await installContent(page, profile);
    await page.evaluate(() => testMessage({ type: 'VB_PICK', mode: 'hide' }));
    await page.evaluate(() => {
      document.getElementById('advert-old').outerHTML = '<div id="advert-replaced">Replacement advert</div>';
    });
    await page.waitForFunction(() => testShadow.querySelector('.choices').textContent.includes('advert-replaced'));
    const beforeSave = await page.evaluate(() => testMessage({ type: 'VB_STATUS' }));
    assert.equal(beforeSave.dirty, false);
    await page.keyboard.press('Enter');
    await page.waitForFunction(async () => !(await testMessage({ type: 'VB_STATUS' })).picking);
    const saved = await page.evaluate(() => {
      const entry = testStore[ViewBlockCore.keyFor(location.origin)].selections[0];
      return { selector: entry.selector, relative: Boolean(entry.relative), display: getComputedStyle(document.getElementById('advert-replaced')).display };
    });
    assert.deepEqual(saved, { selector: '#advert-replaced', relative: true, display: 'none' });
  });
});

function gridMarkup() {
  return '<section id="dashboard-grid" style="display:grid;grid-template-columns:repeat(4,100px);grid-template-rows:repeat(3,60px);gap:10px">' +
    Array.from({ length: 12 }, (_, index) => `<div id="cell-before-${index}"><span>Cell ${index + 1}</span></div>`).join('') + '</section>';
}

test('grid: a cell retains its row and column when its own and neighbor identifiers change', async () => {
  await withPage(gridMarkup(), async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('cell-before-6');
      const item = C.describeElement(target, document, 'hide');
      for (const cell of document.getElementById('dashboard-grid').children) cell.removeAttribute('id');
      const normalized = C.normalizeSelections(JSON.parse(JSON.stringify([item])))[0];
      return { row: item.grid?.row, column: item.grid?.column, rows: item.grid?.rows, columns: item.grid?.columns,
        preserved: JSON.stringify(normalized.grid) === JSON.stringify(item.grid),
        found: C.resolveSelection(normalized, document, 'hide') === target,
        keepMisses: C.resolveSelection(normalized, document, 'keep') === null };
    });
    assert.deepEqual(result, { row: 2, column: 3, rows: 3, columns: 4, preserved: true, found: true, keepMisses: true });
  });
});

for (const mutation of ['column count', 'missing cell', 'cell structure']) {
  test(`grid: changed ${mutation} makes positional fallback fail safely`, async () => {
    await withPage(gridMarkup(), async page => {
      const result = await page.evaluate(mutation => {
        const C = ViewBlockCore, grid = document.getElementById('dashboard-grid'), target = grid.children[6];
        const item = C.describeElement(target, document, 'hide');
        for (const cell of grid.children) cell.removeAttribute('id');
        if (mutation === 'column count') grid.style.gridTemplateColumns = 'repeat(3,100px)';
        else if (mutation === 'missing cell') target.remove();
        else target.innerHTML = '<button>Unrelated replacement control</button>';
        return C.resolveSelection(item, document, 'hide') === null;
      }, mutation);
      assert.equal(result, true);
    });
  });
}

test('content: a grid cell remains hidden across repeated re-resolution and preview saving', async () => {
  await withPage(gridMarkup(), async page => {
    const profile = await page.evaluate(() => ViewBlockCore.saveMode(null, 'hide', [
      ViewBlockCore.describeElement(document.getElementById('cell-before-6'), document, 'hide')
    ]));
    await installContent(page, profile);
    await page.waitForFunction(() => getComputedStyle(document.getElementById('cell-before-6')).display === 'none');
    await page.evaluate(() => {
      globalThis.gridTarget = document.getElementById('cell-before-6');
      for (const cell of document.getElementById('dashboard-grid').children) cell.removeAttribute('id');
    });
    const status = await page.evaluate(() => testMessage({ type: 'VB_APPLY_SAVED' }));
    assert.equal(status.missing, 0);
    assert.equal(await page.evaluate(() => getComputedStyle(gridTarget).display), 'none');
    await page.evaluate(() => testMessage({ type: 'VB_APPLY_SAVED' }));
    assert.equal(await page.evaluate(() => getComputedStyle(gridTarget).display), 'none');
    await page.evaluate(() => testMessage({ type: 'VB_PICK', mode: 'hide' }));
    await page.evaluate(() => [...testShadow.querySelectorAll('button')].find(button => button.textContent === 'Предпросмотр').click());
    assert.equal(await page.evaluate(() => getComputedStyle(gridTarget).display), 'none');
    await page.keyboard.press('Enter');
    await page.waitForFunction(async () => !(await testMessage({ type: 'VB_STATUS' })).picking);
    const saved = await page.evaluate(() => {
      const item = testStore[ViewBlockCore.keyFor(location.origin)].selections[0];
      return { row: item.grid?.row, column: item.grid?.column, found: getComputedStyle(gridTarget).display === 'none' };
    });
    assert.deepEqual(saved, { row: 2, column: 3, found: true });
  });
});

test('content: two hidden grid cells keep their original positions after both identifiers change', async () => {
  await withPage(gridMarkup(), async page => {
    const profile = await page.evaluate(() => {
      globalThis.gridTargets = [document.getElementById('cell-before-1'), document.getElementById('cell-before-11')];
      return ViewBlockCore.saveMode(null, 'hide', gridTargets.map(target => ViewBlockCore.describeElement(target, document, 'hide')));
    });
    await installContent(page, profile);
    await page.waitForFunction(() => gridTargets.every(target => getComputedStyle(target).display === 'none'));
    await page.evaluate(() => {
      for (const cell of document.getElementById('dashboard-grid').children) cell.removeAttribute('id');
    });
    const status = await page.evaluate(() => testMessage({ type: 'VB_APPLY_SAVED' }));
    assert.equal(status.missing, 0);
    const hidden = await page.evaluate(() => [...document.getElementById('dashboard-grid').children]
      .flatMap((cell, index) => getComputedStyle(cell).display === 'none' ? [index] : []));
    assert.deepEqual(hidden, [1, 11]);
  });
});

const smallGrid = '<section id="dashboard-grid" style="display:grid;grid-template-columns:repeat(3,100px);grid-template-rows:60px">' +
  '<div id="left">Left</div><div id="target">Target</div><div id="right">Right</div></section>';

test('grid: matching dimensions never override contradictory surviving anchors', async () => {
  await withPage(smallGrid, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('target');
      const item = C.describeElement(target, document, 'hide');
      target.remove();
      document.getElementById('dashboard-grid').insertAdjacentHTML('afterbegin', '<div>New cell</div>');
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true, 'The old column now contains the stable left anchor, which must remain visible');
  });
});

test('grid: one missing anchor does not permit hiding the other surviving anchor', async () => {
  await withPage(smallGrid, async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore, target = document.getElementById('target');
      const item = C.describeElement(target, document, 'hide'), grid = document.getElementById('dashboard-grid');
      target.remove(); document.getElementById('left').remove();
      grid.insertAdjacentHTML('afterbegin', '<div>New first cell</div>');
      grid.insertAdjacentHTML('beforeend', '<div>New last cell</div>');
      return C.resolveSelection(item, document, 'hide') === null;
    });
    assert.equal(result, true, 'The old column now contains the stable right anchor, which must remain visible');
  });
});

test('grid: the page body can anchor a grid while remaining forbidden as a selected block', async () => {
  await withPage('', async page => {
    const result = await page.evaluate(() => {
      const C = ViewBlockCore;
      document.body.style.cssText = 'display:grid;grid-template-columns:repeat(4,100px);grid-template-rows:repeat(3,60px);gap:10px';
      document.body.innerHTML = Array.from({ length: 12 }, (_, index) => `<div id="cell-before-${index}">Cell ${index}</div>`).join('');
      const target = document.body.children[6], item = C.describeElement(target, document, 'hide');
      for (const cell of document.body.children) cell.removeAttribute('id');
      let bodyRejected = false;
      try { C.describeElement(document.body, document, 'hide'); } catch { bodyRejected = true; }
      return { containerTag: item.grid?.container.tag, found: C.resolveSelection(item, document, 'hide') === target, bodyRejected };
    });
    assert.deepEqual(result, { containerTag: 'body', found: true, bodyRejected: true });
  });
});

test('grid: an explicitly spanning cell never receives grid fallback even when its box fits one track', async () => {
  await withPage(gridMarkup(), async page => {
    const result = await page.evaluate(() => {
      const target = document.getElementById('cell-before-0');
      target.style.gridColumn = 'span 2'; target.style.width = '100px';
      return Boolean(ViewBlockCore.describeElement(target, document, 'hide').grid);
    });
    assert.equal(result, false);
  });
});
