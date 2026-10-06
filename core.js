/* Shared, dependency-free logic. Runs in the extension's isolated world. */
(() => {
  'use strict';
  const PREFIX = 'viewblock.site:';
  const MAX_BLOCKS = 32;
  const MAX_RELATIVE_DEPTH = 6, MAX_ANCHOR_DISTANCE = 64, MAX_CHILDREN = 4096;
  const MAX_GRID_TRACKS = 64, MAX_GRID_CELLS = 256;
  const validTag = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/.test(value) && !['html', 'body'].includes(value);
  const validSelector = value => typeof value === 'string' && value.length > 0 && value.length <= 4096;
  function siteFromUrl(value) {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Откройте обычную страницу сайта (http или https).');
    if (url.hostname === 'chromewebstore.google.com' || (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore'))) {
      throw new Error('Chrome не разрешает изменять страницы магазина расширений.');
    }
    return { origin: url.origin, host: url.host, pattern: `${url.protocol}//${url.hostname}/*` };
  }
  const keyFor = origin => PREFIX + origin;
  const scriptId = origin => 'vb-' + Array.from(new TextEncoder().encode(origin), b => b.toString(16).padStart(2, '0')).join('');
  function stableToken(value) {
    return typeof value === 'string' && value.length > 1 && value.length < 100 &&
      !/^(active|selected|open|closed|focus|hover|loading|hidden|visible|is-|has-|css-|sc-)/i.test(value) &&
      !/--[A-Za-z0-9_+\/-]{4,}$/.test(value) &&
      !/\d{4,}|[a-f0-9]{8,}|[a-z][A-Z][a-zA-Z0-9_-]{9,}/.test(value);
  }
  function normalizeSelections(value) {
    if (!Array.isArray(value) || !value.length || value.length > MAX_BLOCKS) throw new Error(`Выберите от 1 до ${MAX_BLOCKS} блоков.`);
    return value.map(item => {
      if (!item || !validSelector(item.selector) || !validTag(item.tag)) {
        throw new Error('Некорректное описание блока. Выберите его заново.');
      }
      const result = { selector: item.selector, tag: item.tag, fragile: Boolean(item.fragile) };
      const relative = normalizeRelative(item.relative, item.tag);
      if (relative) result.relative = relative;
      const grid = normalizeGrid(item.grid, item.tag);
      if (grid) result.grid = grid;
      return result;
    });
  }
  function normalizeRelative(value, targetTag) {
    if (!value || !validTag(value.tag) || !Array.isArray(value.path) || value.path.length > MAX_RELATIVE_DEPTH) return null;
    const result = { tag: value.tag, path: [] };
    for (const side of ['before', 'after']) {
      const anchor = value[side];
      if (anchor === undefined) continue;
      if (!anchor || !validSelector(anchor.selector) || !validTag(anchor.tag) ||
          !Number.isInteger(anchor.distance) || anchor.distance < 1 || anchor.distance > MAX_ANCHOR_DISTANCE) return null;
      result[side] = { selector: anchor.selector, tag: anchor.tag, distance: anchor.distance };
    }
    if (!result.before && !result.after) return null;
    if (!result.before || !result.after) {
      if (!Number.isInteger(value.edge) || value.edge < 0 || value.edge >= MAX_CHILDREN) return null;
      result.edge = value.edge;
    }
    for (const step of value.path) {
      if (!step || !validTag(step.tag) || !Number.isInteger(step.count) || step.count < 1 || step.count > MAX_CHILDREN ||
          !Number.isInteger(step.index) || step.index < 0 || step.index >= step.count) return null;
      result.path.push({ tag: step.tag, index: step.index, count: step.count });
    }
    return (result.path.at(-1)?.tag ?? result.tag) === targetTag ? result : null;
  }
  function normalizeGrid(value, targetTag) {
    const bodyContainer = value?.container?.selector === 'body' && value.container.tag === 'body';
    if (!value || !validSelector(value.container?.selector) || (!validTag(value.container?.tag) && !bodyContainer) || !validTag(value.tag) ||
        !Number.isInteger(value.rows) || value.rows < 1 || value.rows > MAX_GRID_TRACKS ||
        !Number.isInteger(value.columns) || value.columns < 1 || value.columns > MAX_GRID_TRACKS ||
        !Number.isInteger(value.row) || value.row < 1 || value.row > value.rows ||
        !Number.isInteger(value.column) || value.column < 1 || value.column > value.columns ||
        !Number.isInteger(value.count) || value.count < 1 || value.count > MAX_GRID_CELLS || value.count > value.rows * value.columns ||
        typeof value.shape !== 'string' || !value.shape || value.shape.length > 2048 || !/^[a-z0-9:(),-]+$/.test(value.shape) ||
        !Array.isArray(value.path) || value.path.length > MAX_RELATIVE_DEPTH) return null;
    const result = { container: { selector: value.container.selector, tag: value.container.tag }, tag: value.tag,
      row: value.row, column: value.column, rows: value.rows, columns: value.columns, count: value.count, shape: value.shape, path: [] };
    for (const step of value.path) {
      if (!step || !validTag(step.tag) || !Number.isInteger(step.count) || step.count < 1 || step.count > MAX_CHILDREN ||
          !Number.isInteger(step.index) || step.index < 0 || step.index >= step.count) return null;
      result.path.push({ tag: step.tag, index: step.index, count: step.count });
    }
    return (result.path.at(-1)?.tag ?? result.tag) === targetTag ? result : null;
  }
  // Legacy mail profiles keep their explicit exclusions, without site heuristics.
  const profileMode = value => ['hide', 'mail'].includes(value?.mode) ? 'hide' : 'keep';
  function normalizeModeEntry(value, mode, legacy = false) {
    if (!value || typeof value !== 'object') return null;
    try {
      const selections = mode === 'hide' && ((legacy && value.selections === undefined) ||
        (Array.isArray(value.selections) && value.selections.length === 0)) ? [] : normalizeSelections(value.selections);
      const result = { selections };
      if (Number.isFinite(value.updatedAt)) result.updatedAt = value.updatedAt;
      return result;
    } catch { return null; }
  }
  function projectProfile(mode, enabled, modes) {
    const active = modes[mode];
    const result = { version: 3, mode, enabled, modes, selections: active.selections };
    if (Number.isFinite(active.updatedAt)) result.updatedAt = active.updatedAt;
    return result;
  }
  function normalizeProfile(value) {
    if (!value || typeof value !== 'object' ||
        (value.mode !== undefined && !['keep', 'hide', 'mail'].includes(value.mode))) return null;
    let mode = profileMode(value);
    const modes = { keep: null, hide: null };
    if (value.version === 3 || value.modes !== undefined) {
      if (!value.modes || typeof value.modes !== 'object' || Array.isArray(value.modes)) return null;
      for (const name of ['keep', 'hide']) modes[name] = normalizeModeEntry(value.modes[name], name);
      // An invalid bank must not destroy the other valid saved choice.
      if (!modes[mode]) mode = modes.keep ? 'keep' : 'hide';
    } else {
      modes[mode] = normalizeModeEntry(value, mode, true);
    }
    return modes[mode] ? projectProfile(mode, Boolean(value.enabled), modes) : null;
  }
  function getMode(profile, mode) {
    return ['keep', 'hide'].includes(mode) ? normalizeProfile(profile)?.modes[mode] ?? null : null;
  }
  function saveMode(profile, mode, selections, updatedAt = Date.now()) {
    if (!['keep', 'hide'].includes(mode)) throw new Error('Неизвестный режим выбора.');
    const entry = normalizeModeEntry({ selections, updatedAt }, mode);
    if (!entry) {
      if (mode === 'keep' && Array.isArray(selections) && !selections.length) throw new Error(`Выберите от 1 до ${MAX_BLOCKS} блоков.`);
      throw new Error('Некорректное описание блоков. Выберите их заново.');
    }
    const modes = normalizeProfile(profile)?.modes ?? { keep: null, hide: null };
    modes[mode] = entry;
    return projectProfile(mode, true, modes);
  }
  function activateMode(profile, mode) {
    if (!['keep', 'hide'].includes(mode)) throw new Error('Неизвестный режим выбора.');
    const saved = normalizeProfile(profile);
    if (!saved?.modes[mode]) throw new Error('В этом режиме ещё нет сохранённого выбора. Сначала выберите блоки.');
    return projectProfile(mode, true, saved.modes);
  }
  function isSelectable(el, doc) {
    return el && el.nodeType === 1 && el !== doc.body && el !== doc.documentElement &&
      doc.body?.contains(el) && !['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'].includes(el.tagName);
  }
  function elementHooks(node, doc) {
    const escape = doc.defaultView.CSS.escape;
    const tag = node.localName;
    const options = [];
    if (stableToken(node.id)) options.push(`#${escape(node.id)}`);
    for (const name of ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'role', 'aria-label']) {
      const value = node.getAttribute(name);
      if (value && value.length <= 120) options.push(`${tag}[${name}="${escape(value)}"]`);
    }
    // Prefer semantic hooks over CSS-module names and transient theme classes.
    const classes = Array.from(node.classList).filter(stableToken)
      .sort((a, b) => Number(/^(js-|qa-)/.test(b)) - Number(/^(js-|qa-)/.test(a))).slice(0, 4);
    if (classes.length) {
      for (const name of classes) options.push(tag + '.' + escape(name));
      options.push(tag + classes.map(c => '.' + escape(c)).join(''));
    }
    if (['main', 'nav', 'aside', 'header', 'footer', 'article', 'form'].includes(tag)) options.push(tag);
    return options;
  }
  function resolveSelector(selector, tag, doc) {
    try {
      const matches = doc.querySelectorAll(selector);
      if (matches.length !== 1) return null;
      const el = matches[0];
      return el.localName === tag && isSelectable(el, doc) ? el : null;
    } catch { return null; }
  }
  function structuralChildren(parent, doc) {
    return Array.from(parent.children).filter(node => isSelectable(node, doc) && !node.hasAttribute('data-viewblock-ui'));
  }
  function describeRelative(el, doc) {
    let root = el;
    const path = [];
    while (root && root !== doc.body && path.length <= MAX_RELATIVE_DEPTH) {
      const parent = root.parentElement;
      if (!parent) break;
      const siblings = structuralChildren(parent, doc), index = siblings.indexOf(root);
      if (index < 0 || siblings.length > MAX_CHILDREN) break;
      const relative = { tag: root.localName, path: [...path] };
      for (const [side, direction] of [['before', -1], ['after', 1]]) {
        for (let distance = 1; distance <= MAX_ANCHOR_DISTANCE; distance++) {
          const neighbor = siblings[index + direction * distance];
          if (!neighbor) break;
          const selector = elementHooks(neighbor, doc).find(hook => resolveSelector(hook, neighbor.localName, doc) === neighbor);
          if (selector) {
            relative[side] = { selector, tag: neighbor.localName, distance };
            break;
          }
        }
      }
      if (relative.before || relative.after) {
        // A sole anchor also records the opposite boundary. Removing the target
        // must not shift the rule onto the next, otherwise identical sibling.
        if (!relative.before || !relative.after) relative.edge = relative.before ? siblings.length - index - 1 : index;
        return relative;
      }
      path.unshift({ tag: root.localName, index, count: siblings.length });
      root = parent;
    }
    return null;
  }
  function gridShape(root, doc) {
    let visited = 0;
    const walk = (node, depth) => {
      if (++visited > 64) throw new Error('Large cell');
      const children = structuralChildren(node, doc);
      if (children.length > 64) throw new Error('Large cell');
      return `${node.localName}:${children.length}${depth ? '(' + children.map(child => walk(child, depth - 1)).join(',') + ')' : ''}`;
    };
    try { const shape = walk(root, 2); return shape.length <= 2048 ? shape : null; }
    catch { return null; }
  }
  function measureGrid(container, doc) {
    const css = doc.defaultView.getComputedStyle(container);
    if (!['grid', 'inline-grid'].includes(css.display) || css.writingMode !== 'horizontal-tb' || css.direction !== 'ltr' ||
        !['normal', 'start', 'stretch', 'flex-start'].includes(css.justifyContent) ||
        !['normal', 'start', 'stretch', 'flex-start'].includes(css.alignContent) || css.transform !== 'none') return null;
    const tracks = value => {
      const parts = value.replace(/\[[^\]]*\]/g, '').trim().split(/\s+/);
      if (!parts.length || parts.length > MAX_GRID_TRACKS || parts.some(part => !/^\d+(?:\.\d+)?px$/.test(part))) return null;
      const sizes = parts.map(parseFloat);
      return sizes.every(size => size > 0) ? sizes : null;
    };
    const columns = tracks(css.gridTemplateColumns), rows = tracks(css.gridTemplateRows);
    const rect = container.getBoundingClientRect(), px = value => parseFloat(value) || 0;
    if (!columns || !rows || rect.width <= 0 || rect.height <= 0) return null;
    const columnGap = css.columnGap === 'normal' ? 0 : /^\d+(?:\.\d+)?px$/.test(css.columnGap) ? px(css.columnGap) : null;
    const rowGap = css.rowGap === 'normal' ? 0 : /^\d+(?:\.\d+)?px$/.test(css.rowGap) ? px(css.rowGap) : null;
    const width = px(css.width) + (css.boxSizing === 'border-box' ? 0 : px(css.paddingLeft) + px(css.paddingRight) + px(css.borderLeftWidth) + px(css.borderRightWidth));
    const height = px(css.height) + (css.boxSizing === 'border-box' ? 0 : px(css.paddingTop) + px(css.paddingBottom) + px(css.borderTopWidth) + px(css.borderBottomWidth));
    if (columnGap === null || rowGap === null || Math.abs(width - rect.width) > 1 || Math.abs(height - rect.height) > 1) return null;
    const bands = (sizes, origin, gap) => sizes.map(size => {
      const band = { start: origin, end: origin + size }; origin += size + gap; return band;
    });
    const x = bands(columns, rect.left + px(css.borderLeftWidth) + px(css.paddingLeft) - container.scrollLeft, columnGap);
    const y = bands(rows, rect.top + px(css.borderTopWidth) + px(css.paddingTop) - container.scrollTop, rowGap);
    const children = structuralChildren(container, doc);
    if (children.length > MAX_GRID_CELLS) return null;
    const cells = [], occupied = new Set();
    const locate = (bands, start, end) => bands.findIndex(band => start >= band.start - 1 && end <= band.end + 1);
    const singleTrack = (start, end) => {
      const simple = value => value === 'auto' || /^-?\d+$/.test(value) || /^span 1$/.test(value);
      if (!simple(start) || !simple(end)) return false;
      return !/^-?\d+$/.test(start) || !/^-?\d+$/.test(end) || Math.abs(Number(end) - Number(start)) === 1;
    };
    for (const node of children) {
      const style = doc.defaultView.getComputedStyle(node), bounds = node.getBoundingClientRect();
      if (style.display === 'none' || style.visibility !== 'visible' || ['absolute', 'fixed'].includes(style.position)) continue;
      // display:contents, spanning cells, transforms and overlaps have no
      // single unambiguous row/column and cannot be positional fallbacks.
      if (style.display === 'contents' || style.transform !== 'none' ||
          !singleTrack(style.gridRowStart, style.gridRowEnd) || !singleTrack(style.gridColumnStart, style.gridColumnEnd)) return null;
      if (bounds.width <= 0 || bounds.height <= 0) continue;
      const column = locate(x, bounds.left, bounds.right) + 1, row = locate(y, bounds.top, bounds.bottom) + 1;
      if (!column || !row || occupied.has(`${row}:${column}`)) return null;
      occupied.add(`${row}:${column}`); cells.push({ node, row, column });
    }
    return cells.length ? { rows: rows.length, columns: columns.length, cells } : null;
  }
  function describeGrid(el, doc) {
    let root = el;
    const path = [];
    while (root && root !== doc.body && path.length <= MAX_RELATIVE_DEPTH) {
      const parent = root.parentElement;
      if (!parent || (!isSelectable(parent, doc) && parent !== doc.body)) break;
      if (['grid', 'inline-grid'].includes(doc.defaultView.getComputedStyle(parent).display)) {
        const grid = measureGrid(parent, doc), cell = grid?.cells.find(item => item.node === root), shape = cell && gridShape(root, doc);
        if (!cell || !shape) return null;
        let container;
        try { container = parent === doc.body ? { selector: 'body', tag: 'body' } : describeElement(parent, doc); } catch { return null; }
        if (container.fragile) return null;
        return { container: { selector: container.selector, tag: container.tag }, tag: root.localName,
          row: cell.row, column: cell.column, rows: grid.rows, columns: grid.columns, count: grid.cells.length, shape, path };
      }
      const siblings = structuralChildren(parent, doc), index = siblings.indexOf(root);
      if (index < 0 || siblings.length > MAX_CHILDREN) break;
      path.unshift({ tag: root.localName, index, count: siblings.length }); root = parent;
    }
    return null;
  }
  function describeElement(el, doc = document, mode = 'keep') {
    if (!isSelectable(el, doc)) throw new Error('Выберите отдельный блок внутри страницы.');
    const describe = (selector, fragile) => {
      const result = { selector, tag: el.localName, fragile };
      const relative = mode === 'hide' ? describeRelative(el, doc) : null;
      if (relative) result.relative = relative;
      const grid = mode === 'hide' ? describeGrid(el, doc) : null;
      if (grid) result.grid = grid;
      return result;
    };
    const unique = selector => {
      try { const found = doc.querySelectorAll(selector); return found.length === 1 && found[0] === el; }
      catch { return false; }
    };
    const hooks = node => elementHooks(node, doc);
    for (const selector of hooks(el)) if (unique(selector)) return describe(selector, false);
    let node = el;
    const path = [];
    let positional = false;
    while (node && node !== doc.body) {
      const parent = node.parentElement;
      let piece = hooks(node)[0];
      if (!piece || (parent && Array.from(parent.children).filter(child => child.matches(piece)).length !== 1)) {
        const siblings = parent ? Array.from(parent.children).filter(child => child.localName === node.localName) : [];
        piece = `${node.localName}:nth-of-type(${siblings.indexOf(node) + 1})`;
        positional = true;
      }
      path.unshift(piece);
      const selector = path.join(' > ');
      if (unique(selector)) return describe(selector, positional);
      node = parent;
    }
    throw new Error('Не удалось сохранить этот блок. Попробуйте выбрать область крупнее.');
  }
  function resolveRelative(relative, doc) {
    let root = null, parent = null, siblings = null, index = -1;
    for (const [side, direction] of [['before', 1], ['after', -1]]) {
      const anchor = relative[side];
      if (!anchor) continue;
      const neighbor = resolveSelector(anchor.selector, anchor.tag, doc);
      if (!neighbor || (parent && neighbor.parentElement !== parent)) return null;
      parent = neighbor.parentElement;
      siblings = structuralChildren(parent, doc);
      if (siblings.length > MAX_CHILDREN) return null;
      const anchorIndex = siblings.indexOf(neighbor);
      if (anchorIndex < 0) return null;
      index = anchorIndex + direction * anchor.distance;
      const candidate = siblings[index];
      if (!candidate || candidate.localName !== relative.tag || (root && candidate !== root)) return null;
      root = candidate;
    }
    if (!root) return null;
    if (!relative.before || !relative.after) {
      const edge = relative.before ? siblings.length - index - 1 : index;
      if (edge !== relative.edge) return null;
    }
    for (const step of relative.path) {
      const children = structuralChildren(root, doc);
      if (children.length !== step.count || children[step.index]?.localName !== step.tag) return null;
      root = children[step.index];
    }
    return root;
  }
  function resolveGrid(grid, doc) {
    const container = grid.container.tag === 'body' ? doc.body : resolveSelector(grid.container.selector, grid.container.tag, doc);
    if (!container) return null;
    const layout = measureGrid(container, doc);
    if (!layout || layout.rows !== grid.rows || layout.columns !== grid.columns || layout.cells.length !== grid.count) return null;
    let root = layout.cells.find(cell => cell.row === grid.row && cell.column === grid.column)?.node;
    if (!root || root.localName !== grid.tag || gridShape(root, doc) !== grid.shape) return null;
    for (const step of grid.path) {
      const children = structuralChildren(root, doc);
      if (children.length !== step.count || children[step.index]?.localName !== step.tag) return null;
      root = children[step.index];
    }
    return root;
  }
  function resolveSelection(item, doc = document, mode = 'keep') {
    if (!item) return null;
    const direct = resolveSelector(item.selector, item.tag, doc);
    const relative = mode === 'hide' ? normalizeRelative(item.relative, item.tag) : null;
    const grid = mode === 'hide' ? normalizeGrid(item.grid, item.tag) : null;
    if ((!relative && !grid) || (direct && !item.fragile)) return direct;
    // Positional selectors can still match a different block after insertion.
    // Recorded anchors or guarded grid coordinates must verify those rules.
    if (relative) {
      const anchored = resolveRelative(relative, doc);
      if (anchored) return anchored;
      // A recognized anchor contradicting the old position is stronger
      // evidence than a same-shaped cell at the old grid coordinates.
      if (['before', 'after'].some(side => relative[side] &&
          resolveSelector(relative[side].selector, relative[side].tag, doc))) return null;
    }
    return (grid && resolveGrid(grid, doc)) || null;
  }
  function topLevelSelections(elements) {
    const unique = [...new Set(elements)];
    return unique.filter(el => !unique.some(other => other !== el && other.contains(el)));
  }
  function elementLabel(el) {
    if (!el) return '';
    if (el.id) return `${el.localName}#${el.id}`;
    const hook = Array.from(el.classList).find(c => /^(js-|qa-)/.test(c)) || Array.from(el.classList).find(stableToken);
    return `${el.localName}${hook ? '.' + hook : ''}`;
  }
  globalThis.ViewBlockCore = Object.freeze({ PREFIX, MAX_BLOCKS, siteFromUrl, keyFor, scriptId, normalizeSelections,
    profileMode, normalizeProfile, getMode, saveMode, activateMode, stableToken, isSelectable, describeElement, resolveSelection, topLevelSelections,
    elementLabel });
})();
