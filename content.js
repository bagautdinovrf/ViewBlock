(() => {
  'use strict';
  if (globalThis.__viewblockInstalled) return;
  globalThis.__viewblockInstalled = true;
  const PROTOCOL = 4;
  const UPDATE_REQUIRED = 'Перезагрузите ViewBlock в chrome://extensions (круглая стрелка на карточке), затем обновите вкладку сайта.';
  const C = ViewBlockCore, storageKey = C.keyFor(location.origin);
  const helperStorageKey = 'viewblock.helper:' + location.origin;
  let helperHidden = false, helperPrefInitialized = false;
  const marker = 'data-vb-' + crypto.randomUUID().replaceAll('-', '');
  const marked = new Map(), resizeHistory = new Map();
  const nodeIds = new WeakMap();
  let nextNodeId = 0;
  function nodeId(node) {
    if (!node) return 0;
    if (!nodeIds.has(node)) nodeIds.set(node, ++nextNodeId);
    return nodeIds.get(node);
  }
  let profile = null, picking = false, preview = false, applied = false, missing = 0, saving = false;
  let savedSelectionNodes = [];
  let draftMode = 'keep', selection = [], selectionHints = new Map(), activeSelection = null;
  const drafts = { keep: null, hide: null };
  let draftBaseline = '[]';
  let hovered = null, rawHovered = null, candidates = [], point = null;
  let host, shadow, style, observer, timer = 0, frame = 0, position = null, collapsed = false;
  let previousFocus = null, initialized = false, ui = {}, shown = false, dragging = null;
  const ownNode = node => node === host || node === style || host?.contains(node);
  const selectable = node => C.isSelectable(node, document) && !ownNode(node) && !node.contains(host);
  const mode = () => picking && !helperHidden ? draftMode : C.profileMode(profile);
  const needsGridLayout = () => mode() === 'hide' && (picking && !helperHidden
    ? [...selectionHints.values()] : profile?.selections || []).some(item => item.grid);
  const fingerprint = items => JSON.stringify(items.map(item => [item.selector, item.tag]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  const dirty = () => fingerprint(selection.map(node => selectionHints.get(node) || { selector: '', tag: node.localName })) !== draftBaseline;
  function rememberDraft() {
    if (!picking) return;
    drafts[draftMode] = { nodes: [...selection], hints: new Map(selectionHints), active: activeSelection,
      history: new Map(resizeHistory), preview, baseline: draftBaseline, dirty: dirty() };
  }
  function draftStates() {
    return Object.fromEntries(['keep', 'hide'].map(name => [name, picking && draftMode === name
      ? { count: selection.length, dirty: dirty() }
      : drafts[name] ? { count: drafts[name].nodes.length, dirty: drafts[name].dirty } : null]));
  }
  function loadDraft(name, previewSaved) {
    const cached = drafts[name], saved = C.getMode(profile, name);
    // Draft restoration can measure grid positions while the previous mode is
    // still applied. Remove our filtering before inspecting the page layout.
    restore();
    resizeHistory.clear(); selectionHints = new Map(); activeSelection = null;
    if (cached) {
      selection = [...cached.nodes]; selectionHints = new Map(cached.hints); activeSelection = cached.active;
      for (const [parent, child] of cached.history) resizeHistory.set(parent, child);
      draftBaseline = cached.baseline; preview = previewSaved && !cached.dirty && saved ? true : cached.preview;
      refreshSelection();
    } else {
      // Keep a missing descriptor visible in the editor instead of silently
      // dropping it from a saved set when another block is changed.
      selection = (saved?.selections || []).map(item => {
        const node = C.resolveSelection(item, document, name) || document.createElement(item.tag);
        selectionHints.set(node, item); return node;
      });
      activeSelection = selection.at(-1) || null;
      draftBaseline = fingerprint(saved?.selections || []);
      preview = Boolean(previewSaved && saved);
    }
  }

  function restore() {
    for (const node of marked.keys()) node.removeAttribute(marker);
    marked.clear(); applied = false;
  }
  function commitPlan(plan) {
    for (const node of marked.keys()) if (!plan.has(node)) { node.removeAttribute(marker); marked.delete(node); }
    for (const [node, kind] of plan) {
      if (node.getAttribute(marker) !== kind) node.setAttribute(marker, kind);
      marked.set(node, kind);
    }
    applied = true;
  }
  function filter(roots) {
    if (!roots.length || !document.body) { restore(); return; }
    const keep = new Set(C.topLevelSelections(roots)), trails = new Set(), plan = new Map();
    for (const root of keep) for (let node = root.parentElement; node; node = node.parentElement) {
      trails.add(node); if (node === document.body) break;
    }
    // Keep the helper reachable even when hosted in a site's modal dialog.
    for (let node = host.parentElement; node; node = node.parentElement) trails.add(node);
    const stack = [document.body];
    while (stack.length) {
      const node = stack.pop();
      if (ownNode(node) || ['SCRIPT', 'STYLE', 'LINK', 'META', 'NOSCRIPT', 'TEMPLATE'].includes(node.tagName)) continue;
      if (keep.has(node)) plan.set(node, 'keep');
      else if (trails.has(node)) { plan.set(node, 'trail'); stack.push(...node.children); }
      else plan.set(node, 'hide');
    }
    commitPlan(plan);
  }
  function hideBlocks(roots) {
    commitPlan(new Map(C.topLevelSelections(roots).filter(selectable).map(node => [node, 'hide'])));
  }
  function resolveSaved() {
    const nodes = (profile?.selections || []).map(item => C.resolveSelection(item, document, C.profileMode(profile)));
    savedSelectionNodes = nodes;
    missing = nodes.filter(node => !node).length;
    return nodes.filter(Boolean);
  }
  function setSelection(nodes) {
    if (draftMode === 'hide') restore();
    selection = C.topLevelSelections(nodes);
    const hints = new Map();
    for (const node of selection) {
      try { hints.set(node, C.describeElement(node, document, draftMode)); }
      catch { if (selectionHints.has(node)) hints.set(node, selectionHints.get(node)); }
    }
    selectionHints = hints;
    if (!selection.includes(activeSelection)) activeSelection = selection.at(-1) || null;
  }
  function refreshSelection() {
    selection = C.topLevelSelections(selection.map(node => {
      if (node.isConnected) return node;
      const hint = selectionHints.get(node), next = hint && C.resolveSelection(hint, document, draftMode);
      if (!next) return node;
      // Replacing page markup must not turn an unchanged saved choice into a
      // dirty draft. Recapture its selector and anchors when the user saves.
      selectionHints.set(next, hint);
      if (activeSelection === node) activeSelection = next;
      return next;
    }));
    selectionHints = new Map(selection.filter(node => selectionHints.has(node)).map(node => [node, selectionHints.get(node)]));
    if (!selection.includes(activeSelection)) activeSelection = selection.at(-1) || null;
  }
  function applyProfile() {
    ensureUI();
    // display:none collapses grid cells. Measure the original layout and apply
    // its hide plan synchronously, without painting the intermediate state.
    if (needsGridLayout()) restore();
    if (picking && !helperHidden) {
      refreshSelection();
      if (!preview) restore();
      else if (draftMode === 'hide') hideBlocks(selection.filter(node => node.isConnected));
      else if (selection.length && selection.every(node => node.isConnected)) filter(selection);
      else restore();
    } else {
      const roots = resolveSaved();
      if (!profile?.enabled) restore();
      else if (mode() === 'hide') hideBlocks(roots);
      else if (roots.length && !missing) filter(roots);
      else restore();
    }
    render(); draw();
  }
  function schedule() {
    if (!timer) timer = setTimeout(() => { timer = 0; applyProfile(); }, 100);
  }
  function observe() {
    observer = new MutationObserver(records => {
      if (records.some(record => !ownNode(record.target) && ((record.type === 'attributes' &&
        (record.attributeName !== 'style' || needsGridLayout())) ||
        [...record.addedNodes, ...record.removedNodes].some(node => !ownNode(node))))) schedule();
    });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
      attributeFilter: ['id', 'class', 'role', 'aria-label', 'data-testid', 'data-test-id', 'data-test', 'data-qa', 'open', 'style'] });
  }
  function el(tag, attrs = {}, text = '') {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    node.textContent = text; return node;
  }
  function button(text, action, className = '', title = '') {
    const node = el('button', { type: 'button', class: className, ...(title ? { title } : {}) }, text);
    node.addEventListener('click', action); return node;
  }
  function bringToFront(force = false) {
    if (!host || !shown) return;
    const dialogs = [...document.querySelectorAll('dialog:modal')].filter(node => !ownNode(node));
    const parent = dialogs.at(-1) || document.documentElement;
    if (host.parentElement !== parent) { if (host.matches(':popover-open')) host.hidePopover(); parent.append(host); force = true; }
    try {
      if (force && host.matches(':popover-open')) host.hidePopover();
      if (!host.matches(':popover-open')) host.showPopover();
    } catch { /* Fixed positioning remains a fallback on unsupported pages. */ }
  }
  function ensureUI() {
    if (!style?.isConnected) {
      style = el('style');
      style.textContent = `html:root [${marker}="hide"]{display:none!important}html:root [${marker}="trail"]{visibility:hidden!important}html:root [${marker}="keep"]{visibility:visible!important}`;
      document.documentElement.append(style);
    }
    if (host) { if (!host.isConnected) document.documentElement.append(host); return; }
    host = el('div', { 'data-viewblock-ui': '', popover: 'manual',
      style: 'all:initial!important;position:fixed!important;inset:0!important;margin:0!important;padding:0!important;border:0!important;width:100vw!important;height:100vh!important;max-width:none!important;max-height:none!important;background:transparent!important;overflow:visible!important;pointer-events:none!important;z-index:2147483647!important;visibility:visible!important;' });
    shadow = host.attachShadow({ mode: 'closed' });
    const css = el('style');
    css.textContent = `
      :host{color-scheme:light}:host::backdrop{background:transparent;pointer-events:none}*{box-sizing:border-box}[hidden]{display:none!important}
      .vb{font:13px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#eef9f1;text-align:left;letter-spacing:normal}
      button,input,select{font:inherit}button{cursor:pointer;border:1px solid #526e60;border-radius:8px;padding:7px 10px;background:#284e40;color:#f0faf4;line-height:1.3;font-size:12px}
      button:hover{background:#3b6551}button:focus-visible,input:focus-visible,select:focus-visible{outline:3px solid #c8ef6d;outline-offset:2px}button:disabled{opacity:.38;cursor:default}
      .primary{background:#c8ef6d;border-color:#c8ef6d;color:#203324;font-weight:750}.primary:hover{background:#d9ff89}
      .panel,.dock{position:fixed;pointer-events:auto;z-index:3;background:#173b30;border:1px solid #668371;border-radius:15px;box-shadow:0 12px 48px #0007;max-width:calc(100vw - 24px)}
      .panel{width:430px;max-height:calc(100vh - 24px);display:flex;flex-direction:column;overflow:hidden}.top{display:flex;align-items:center;gap:9px;padding:13px 14px;border-bottom:1px solid #3d5e4d;cursor:move;touch-action:none;user-select:none;flex-shrink:0}.brand{font-size:16px;font-weight:750;color:#fff}.badge{font-size:11px;color:#c8ef6d}.top button{margin-left:auto;font-size:11px;padding:5px 7px}.body{padding:12px 14px;overflow:auto;min-height:0}.instructions{font-size:12px;color:#c0d7c8;margin:0 0 10px}.row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.presets{margin-bottom:10px}.section-title{font-size:12px;font-weight:700;margin:10px 0 6px}.choices{display:grid;gap:6px;max-height:190px;overflow:auto}.choice{display:flex;align-items:center;gap:4px;border:1px solid #416852;background:#244b3b;border-radius:8px;padding:6px}.choice.current{border-color:#c8ef6d}.choice .name{flex:1;min-width:0;background:transparent;border:0;text-align:left;padding:2px 4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.choice small{display:block;font-size:10px;color:#bbd4c5;overflow:hidden;text-overflow:ellipsis}.choice button{padding:4px 7px}.empty{font-size:12px;color:#aac6b6;padding:8px 0}.layer-select{width:100%;background:#f4faf6;color:#203a2c;padding:7px;border-radius:7px;border:1px solid #8cab98;margin-bottom:6px}.hint{font-size:11px;color:#b1cbbd;margin:6px 0}.actions{padding:11px 14px;border-top:1px solid #3d5e4d;background:#173b30;display:flex;flex-wrap:wrap;gap:6px;flex-shrink:0}.actions .primary{margin-left:auto}.info{font-size:11px;color:#c7ddce;margin:9px 0 0}.error{color:#ffd298}.advanced{margin-top:10px;font-size:11px;color:#c2d9cc}.advanced summary{cursor:pointer}.advanced .row{margin-top:7px}.advanced input{flex:1;min-width:130px;border:1px solid #93b3a0;border-radius:6px;background:#f4faf6;color:#213b2c;padding:7px}.dock{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:move;touch-action:none}.dock .brand{font-size:13px}
      .mask{position:fixed;inset:0;pointer-events:auto;z-index:0;background:transparent;cursor:crosshair;touch-action:none}.layer{position:fixed;inset:0;pointer-events:none;z-index:2}.outline{position:fixed;pointer-events:none;border:2px solid #42e3a1;box-shadow:0 0 0 1px #142c22,0 0 0 3px #fff9;background:#36d89415;border-radius:3px}.outline.hover{border:3px solid #d9fc57;background:#e3ff6035;box-shadow:0 0 0 2px #263c2c,0 0 22px #dcff7199}.label{position:absolute;top:0;left:0;transform:translateY(-100%);padding:3px 6px;max-width:350px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;background:#174d36;color:white;border-radius:4px;font:11px/1.3 system-ui}.hover .label{background:#d9fc57;color:#213b2a}
    `;
    css.textContent += `.presets{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0 8px}.mode-card{text-align:left;padding:10px 12px;background:#244b3b;border:1px solid #526e60;font-size:14px;font-weight:700}.mode-card small{display:block;font-size:11px;font-weight:400;color:#bfd3c8;margin-top:3px}.mode-card.active{border-color:#c8ef6d;background:#35543a;box-shadow:inset 0 0 0 1px #c8ef6d}.mode-card.active>span{color:#d9ff89}.mode-hint{padding:9px 10px;border-radius:8px;background:#244638;margin:0 0 12px;color:#d0e4d7}.actions .primary{min-width:104px}.info{min-height:30px}`;
    css.textContent += `.top{flex-wrap:wrap}.top-actions{display:flex;gap:6px;margin-left:auto;flex-shrink:0}.top-actions button{margin-left:0}`;
    ui.mask = el('div', { class: 'mask', hidden: '' });
    ui.layer = el('div', { class: 'vb layer', 'aria-hidden': 'true' });
    ui.hover = el('div', { class: 'outline hover', hidden: '' });
    ui.hoverLabel = el('span', { class: 'label' }); ui.hover.append(ui.hoverLabel); ui.layer.append(ui.hover);
    ui.panel = el('section', { class: 'vb panel', hidden: '', role: 'dialog', tabindex: '-1', 'aria-label': 'ViewBlock — помощник' });
    const top = el('div', { class: 'top', 'data-drag-handle': '', title: 'Переместить окно' });
    ui.count = el('span', { class: 'badge' });
    const hideHelper = () => setHelperVisibility(false).catch(error => render(error.message || String(error), true));
    const hideTitle = 'Скрыть помощник. Вернуть: значок ViewBlock в Chrome → Показать помощник';
    ui.hide = button('Скрыть', hideHelper, '', hideTitle);
    const topActions = el('div', { class: 'top-actions' });
    topActions.append(button('Свернуть', () => { collapsed = true; render(); }), ui.hide);
    top.append(el('span', { class: 'brand' }, 'ViewBlock'), ui.count, topActions);
    ui.body = el('div', { class: 'body' });
    ui.instructions = el('p', { class: 'instructions' });
    const presets = el('div', { class: 'row presets' });
    ui.keep = button('Оставить', () => switchMode('keep'));
    ui.remove = button('Убрать', () => switchMode('hide'));
    presets.append(ui.keep, ui.remove);
    ui.modeHint = el('p', { class: 'hint mode-hint' }, 'У каждого режима свой выбор. Переключение его не удаляет.');
    ui.title = el('div', { class: 'section-title' });
    ui.choices = el('div', { class: 'choices', 'aria-label': 'Выбранные блоки' });
    ui.picker = el('div');
    const layerLabel = el('label', { for: 'vb-layers', class: 'section-title' }, 'Блоки под курсором');
    ui.layers = el('select', { id: 'vb-layers', class: 'layer-select', 'aria-label': 'Блоки под курсором' });
    ui.layers.addEventListener('change', () => { hovered = candidates[Number(ui.layers.value)] || null; updateControls(); draw(); });
    ui.allLayers = button('Все слои', () => samplePoint(true), '', 'Найти также перекрытые блоки и элементы, пропускающие нажатия');
    ui.add = button('Добавить блок', toggleHovered);
    ui.larger = button('+ Крупнее', () => activeSelection ? resizeSelected(activeSelection, 1) : chooseParent());
    ui.smaller = button('− Мельче', () => activeSelection ? resizeSelected(activeSelection, -1) : chooseChild());
    const layerActions = el('div', { class: 'row' }); layerActions.append(ui.allLayers, ui.add, ui.larger, ui.smaller);
    ui.picker.append(layerLabel, ui.layers, layerActions, el('p', { class: 'hint' }, 'Наведите на страницу, затем выберите слой в списке. [ / ] — перебор слоёв; + / − — размер.'));
    const advanced = el('details', { class: 'advanced' }); advanced.append(el('summary', {}, 'Выбрать по CSS-селектору'));
    const selectorRow = el('div', { class: 'row' });
    ui.selector = el('input', { type: 'text', placeholder: '#content', 'aria-label': 'CSS-селектор блока', autocomplete: 'off', spellcheck: 'false' });
    ui.selector.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); chooseSelector(); } });
    selectorRow.append(ui.selector, button('Добавить', chooseSelector)); advanced.append(selectorRow); ui.picker.append(advanced);
    ui.info = el('p', { class: 'info', role: 'status' });
    ui.body.append(ui.instructions, presets, ui.modeHint, ui.title, ui.choices, ui.picker, ui.info);
    const actions = el('div', { class: 'actions' });
    ui.edit = button('Изменить выбор', () => startPicking());
    ui.preview = button('Предпросмотр', () => { preview = !preview; hovered = null; applyProfile(); });
    ui.full = button('Показать полную страницу', showFull);
    ui.enable = button('Применить', () => toggleEnabled(true));
    ui.cancel = button('Отмена · Esc', cancelPicking);
    ui.save = button('Сохранить', savePicking, 'primary');
    actions.append(ui.edit, ui.preview, ui.full, ui.enable, ui.cancel, ui.save);
    ui.panel.append(top, ui.body, actions);
    ui.dock = el('section', { class: 'vb dock', hidden: '', title: 'Переместить окно' });
    ui.dockHide = button('Скрыть', hideHelper, '', hideTitle);
    ui.dock.append(el('span', { class: 'brand' }, 'ViewBlock'), button('Развернуть', () => { collapsed = false; render(); }), ui.dockHide);
    shadow.append(css, ui.mask, ui.layer, ui.panel, ui.dock); document.documentElement.append(host);
    setupDrag(top); setupDrag(ui.dock);
    new ResizeObserver(clampPosition).observe(ui.panel);
    ui.mask.addEventListener('pointermove', event => {
      if (!picking || preview || saving) return;
      if (!point || Math.abs(point.x - event.clientX) + Math.abs(point.y - event.clientY) > 3) {
        point = { x: event.clientX, y: event.clientY }; samplePoint(false);
      }
    });
    ui.mask.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (!picking || preview || saving) return;
      if (!point || Math.abs(point.x - event.clientX) + Math.abs(point.y - event.clientY) > 3) {
        point = { x: event.clientX, y: event.clientY }; samplePoint(false);
      }
      toggleHovered();
    });
    for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'dblclick', 'contextmenu']) ui.mask.addEventListener(type, event => { event.preventDefault(); event.stopPropagation(); });
    ui.mask.addEventListener('wheel', scrollPage, { passive: false });
    window.addEventListener('keydown', keyboard, true);
    window.addEventListener('scroll', scheduleDraw, true);
    window.addEventListener('resize', () => { clampPosition(); scheduleDraw(); if (needsGridLayout()) schedule(); });
    document.addEventListener('toggle', event => { if (event.target !== host) setTimeout(() => bringToFront(true), 0); }, true);
  }
  function clampPosition() {
    if (!host || !shown) return;
    const panel = collapsed ? ui.dock : ui.panel, r = panel.getBoundingClientRect();
    if (!position) position = { x: innerWidth - Math.min(430, innerWidth - 24) - 18, y: 70 };
    position.x = Math.max(12, Math.min(position.x, innerWidth - r.width - 12));
    position.y = Math.max(12, Math.min(position.y, innerHeight - r.height - 12));
    for (const node of [ui.panel, ui.dock]) { node.style.left = position.x + 'px'; node.style.top = position.y + 'px'; }
  }
  function setupDrag(handle) {
    handle.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('button')) return;
      dragging = { x: event.clientX, y: event.clientY, left: position.x, top: position.y };
      handle.setPointerCapture(event.pointerId); event.preventDefault();
    });
    handle.addEventListener('pointermove', event => {
      if (!dragging) return;
      position = { x: dragging.left + event.clientX - dragging.x, y: dragging.top + event.clientY - dragging.y };
      clampPosition(); event.preventDefault();
    });
    handle.addEventListener('pointerup', () => { dragging = null; });
    handle.addEventListener('lostpointercapture', () => { dragging = null; });
  }
  function render(text = '', isError = false) {
    shown = !helperHidden && (picking || Boolean(profile));
    ui.panel.hidden = !shown || collapsed; ui.dock.hidden = !shown || !collapsed;
    // Preview keeps the page inert to accidental clicks, but allows scrolling.
    ui.mask.hidden = !picking || !shown;
    ui.layer.hidden = !shown;
    if (!shown) { if (host.matches(':popover-open')) host.hidePopover(); return; }
    bringToFront();
    const hiding = mode() === 'hide';
    ui.count.textContent = picking ? (dirty() ? 'Есть изменения' : preview ? 'Предпросмотр' : 'Выбор блоков') : (applied ? 'Сохранено · включено' : 'Полная страница');
    ui.instructions.textContent = hiding ? 'Уберите лишнее — остальные области останутся на странице.' : 'Оставьте нужное — остальные области будут скрыты.';
    ui.keep.setAttribute('aria-pressed', String(!hiding)); ui.remove.setAttribute('aria-pressed', String(hiding));
    const states = draftStates();
    for (const [name, control, label] of [['keep', ui.keep, 'Оставить'], ['hide', ui.remove, 'Убрать']]) {
      const saved = C.getMode(profile, name), draft = states[name];
      control.className = 'mode-card' + (mode() === name ? ' active' : '');
      control.replaceChildren(el('span', {}, label), el('small', {}, draft?.dirty ? `${draft.count} · не сохранено` : saved ? `${saved.selections.length} · сохранено` : 'Не настроено'));
    }
    ui.modeHint.textContent = picking
      ? (preview ? 'Сейчас виден результат. Вернитесь к выбору, чтобы изменить блоки.' : 'Нажмите на блок страницы. Если нужна область крупнее, нажмите + рядом с ней.')
      : 'У каждого режима свой сохранённый выбор. Можно свободно переключаться.';
    ui.title.textContent = `${hiding ? 'Скрываемые' : 'Оставляемые'} блоки · ${(picking ? selection : profile?.selections || []).length}`;
    ui.picker.hidden = !picking || preview;
    ui.edit.hidden = picking; ui.preview.hidden = !picking; ui.cancel.hidden = !picking;
    ui.save.hidden = !picking;
    ui.enable.hidden = picking || Boolean(profile?.enabled);
    ui.preview.textContent = preview ? 'Вернуться к выбору' : 'Предпросмотр';
    ui.save.disabled = !picking || saving || (!hiding && !selection.length);
    ui.save.textContent = saving ? 'Сохраняем…' : 'Сохранить';
    ui.cancel.textContent = dirty() ? 'Отменить изменения' : 'Закрыть выбор';
    ui.preview.disabled = saving || (!hiding && !selection.length && !preview);
    ui.keep.disabled = saving; ui.remove.disabled = saving; ui.full.disabled = saving;
    ui.edit.disabled = saving; ui.enable.disabled = saving; ui.cancel.disabled = saving;
    ui.hide.disabled = saving; ui.dockHide.disabled = saving;
    renderChoices(); updateControls(); clampPosition();
    const disconnected = picking ? selection.filter(node => !node.isConnected).length : missing;
    if (!text && disconnected) {
      text = picking ? `Не найдено выбранных блоков: ${disconnected}. Выберите их заново или удалите из списка.`
        : hiding ? `Не найдено блоков: ${disconnected}. Остальные выбранные блоки скрыты.`
        : `Не найдено блоков: ${disconnected}. Показана полная страница.`;
      isError = true;
    }
    ui.info.className = 'info' + (isError ? ' error' : '');
    const otherDraft = states[hiding ? 'keep' : 'hide'];
    ui.info.textContent = text || (picking ? (dirty() ? 'Изменения ещё не сохранены. Enter — сохранить · Esc — отменить.' : preview ? 'Сохранённый выбор восстановлен. Нажмите «Сохранить», чтобы применить режим.' : selection.length ? 'Полная страница открыта для выбора. Сохранённые блоки отмечены в списке.' : 'Выберите блоки, проверьте предпросмотр и сохраните результат.')
      : otherDraft?.dirty ? 'В другом режиме остался черновик. Нажмите его название, чтобы продолжить.' : 'Настройки сохранены для этого сайта.');
  }
  function updateControls() {
    ui.add.disabled = !hovered || saving || preview;
    ui.allLayers.disabled = !point || saving || preview;
    const target = activeSelection || hovered;
    ui.larger.disabled = saving || preview || !selectable(target?.parentElement);
    ui.smaller.disabled = saving || preview || (activeSelection ? !resizeHistory.get(activeSelection)?.isConnected : !hovered || !rawHovered || hovered === rawHovered);
  }
  function renderChoices() {
    const entries = [];
    if (picking) for (const node of selection) entries.push({ node });
    else (profile?.selections || []).forEach((descriptor, index) => entries.push({ node: savedSelectionNodes[index], descriptor }));
    // A SPA may replace a node with identical markup. Rebuild row closures then.
    const signature = JSON.stringify(entries.map(({ node, descriptor }) => [nodeId(node), C.elementLabel(node), descriptor?.selector, node?.isConnected, node === activeSelection, !!resizeHistory.get(node)?.isConnected])) + picking + preview + saving + mode();
    if (signature === ui.choiceSignature) return;
    ui.choiceSignature = signature; ui.choices.replaceChildren();
    if (!entries.length) ui.choices.append(el('div', { class: 'empty' }, picking ? 'Нажмите на нужную область страницы — она появится здесь.' : 'В этом режиме ни один блок не скрывается.'));
    entries.forEach(({ node, descriptor }, index) => {
      const row = el('div', { class: 'choice' + (node === activeSelection ? ' current' : '') });
      const name = (node?.isConnected && C.elementLabel(node)) || descriptor?.selector || selectionHints.get(node)?.selector || 'Исчезнувший блок';
      const readableName = blockName(node);
      const label = button(`${index + 1}. ${readableName}`, () => {
        if (!node?.isConnected) return;
        activeSelection = node;
        node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); hovered = rawHovered = node; draw(); updateControls();
      }, 'name', name);
      label.append(el('small', {}, node?.isConnected ? name : `Не найден · ${name}`));
      row.append(label);
      if (picking) {
        const bigger = button('+', () => resizeSelected(node, 1), '', 'Выбрать родительский блок');
        const smaller = button('−', () => resizeSelected(node, -1), '', 'Вернуться к предыдущему размеру');
        const remove = button('×', () => { setSelection(selection.filter(item => item !== node)); applyProfile(); }, '', 'Убрать этот блок из выбора');
        bigger.disabled = preview || saving || !selectable(node?.parentElement);
        smaller.disabled = preview || saving || !resizeHistory.get(node)?.isConnected; remove.disabled = saving;
        row.append(bigger, smaller, remove);
      }
      ui.choices.append(row);
    });
  }
  function blockName(node) {
    if (!node?.isConnected) return 'Блок временно недоступен';
    const named = node.getAttribute('aria-label') || node.querySelector(':scope > h1, :scope > h2, :scope > h3')?.textContent;
    if (named?.trim()) return named.trim().replace(/\s+/g, ' ').slice(0, 72);
    const roles = { main: 'Основное содержимое', navigation: 'Навигация', list: 'Список', menu: 'Меню', menubar: 'Панель действий', search: 'Поиск', toolbar: 'Панель действий', complementary: 'Боковая область' };
    const tags = { main: 'Основное содержимое', nav: 'Навигация', aside: 'Боковая область', header: 'Верхняя панель', footer: 'Нижняя панель', ul: 'Список', ol: 'Список', section: 'Раздел', article: 'Материал', form: 'Форма' };
    return roles[node.getAttribute('role')] || tags[node.localName] || 'Блок страницы';
  }
  function samplePoint(all) {
    if (!point || preview) return;
    const { x, y } = point;
    const stack = document.elementsFromPoint(x, y).filter(selectable), found = [];
    const add = node => {
      if (!selectable(node) || found.includes(node)) return;
      const r = node.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) found.push(node);
    };
    for (const node of stack) add(node);
    for (const node of stack) for (let parent = node.parentElement; selectable(parent); parent = parent.parentElement) add(parent);
    if (all) {
      // Bounded geometry scan only on explicit request, including pointer-events:none.
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let node, visited = 0;
      while ((node = walker.nextNode()) && visited++ < 12000 && found.length < 250) {
        if (!selectable(node)) continue;
        const r = node.getBoundingClientRect();
        if (r.width && r.height && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
          const css = getComputedStyle(node);
          if (css.visibility === 'visible' && css.display !== 'none' && Number(css.opacity) !== 0) add(node);
        }
      }
      render(`Найдено слоёв: ${found.length}.${visited >= 12000 || found.length >= 250 ? ' Достигнут предел поиска; уточните область или CSS-селектор.' : ' Выберите нужный в списке.'}`);
    }
    candidates = found;
    if (!all || !candidates.includes(hovered)) hovered = candidates[0] || null;
    rawHovered = candidates[0] || null;
    renderLayers(); updateControls(); draw();
  }
  function renderLayers() {
    ui.layers.replaceChildren();
    if (!candidates.length) ui.layers.append(el('option', { value: '-1' }, 'Наведите на нужный участок страницы'));
    candidates.forEach((node, index) => {
      const r = node.getBoundingClientRect();
      ui.layers.append(el('option', { value: String(index) }, `${index + 1}. ${C.elementLabel(node)} · ${Math.round(r.width)} × ${Math.round(r.height)}`));
    });
    ui.layers.value = String(candidates.indexOf(hovered));
  }
  function cycleLayer(direction) {
    if (!candidates.length || preview) return;
    const index = (candidates.indexOf(hovered) + direction + candidates.length) % candidates.length;
    hovered = candidates[index]; ui.layers.value = String(index); updateControls(); draw();
  }
  function scrollPage(event) {
    event.preventDefault(); event.stopPropagation();
    if (event.altKey) { cycleLayer(event.deltaY > 0 ? 1 : -1); return; }
    const amount = event.deltaMode === 1 ? 18 : event.deltaMode === 2 ? innerHeight : 1;
    const nodes = document.elementsFromPoint(event.clientX, event.clientY).filter(node => !ownNode(node));
    for (const first of nodes) for (let node = first; node && node !== document.body; node = node.parentElement) {
      const css = getComputedStyle(node), dy = event.deltaY * amount, dx = event.deltaX * amount;
      const canY = /(auto|scroll)/.test(css.overflowY) && (dy > 0 ? node.scrollTop + node.clientHeight < node.scrollHeight : node.scrollTop > 0);
      const canX = /(auto|scroll)/.test(css.overflowX) && (dx > 0 ? node.scrollLeft + node.clientWidth < node.scrollWidth : node.scrollLeft > 0);
      if (canY || canX) { node.scrollBy(dx, dy); scheduleDraw(); return; }
    }
    window.scrollBy(event.deltaX * amount, event.deltaY * amount); scheduleDraw();
  }
  function toggleHovered() {
    if (!hovered?.isConnected || saving || preview) return;
    const containing = selection.find(node => node.contains(hovered));
    if (containing) setSelection(selection.filter(node => node !== containing));
    else {
      if (selection.length >= C.MAX_BLOCKS) { render(`Можно выбрать до ${C.MAX_BLOCKS} блоков.`, true); return; }
      activeSelection = hovered; setSelection([...selection, hovered]);
    }
    render(); draw();
  }
  function chooseParent() {
    if (preview || saving || !selectable(hovered?.parentElement)) return;
    hovered = hovered.parentElement; updateControls(); draw();
  }
  function chooseChild() {
    if (preview || saving || !hovered || !rawHovered || hovered === rawHovered) return;
    let child = rawHovered;
    while (child.parentElement && child.parentElement !== hovered) child = child.parentElement;
    if (child.parentElement === hovered) hovered = child;
    updateControls(); draw();
  }
  function resizeSelected(node, direction) {
    refreshSelection();
    if (!selection.includes(node) || !node.isConnected || saving || preview) return;
    const next = direction > 0 ? node.parentElement : resizeHistory.get(node);
    if (!selectable(next)) return;
    if (direction > 0) resizeHistory.set(next, node);
    activeSelection = next; setSelection(selection.map(item => item === node ? next : item));
    hovered = next; rawHovered = direction > 0 ? node : next; render(); draw();
  }
  function chooseSelector() {
    if (saving || !picking) return;
    try {
      const matches = document.querySelectorAll(ui.selector.value.trim());
      if (matches.length !== 1 || !selectable(matches[0])) throw new Error('Селектор должен находить ровно один блок внутри страницы.');
      if (selection.length >= C.MAX_BLOCKS) throw new Error(`Можно выбрать до ${C.MAX_BLOCKS} блоков.`);
      activeSelection = matches[0]; setSelection([...selection, matches[0]]); preview = false; applyProfile();
    } catch (error) { render(error instanceof DOMException ? 'Проверьте синтаксис CSS-селектора.' : error.message, true); }
  }
  function drawRect(box, target) {
    const r = target.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }
  function draw() {
    ui.layer.querySelectorAll('.selected').forEach(node => node.remove());
    if (picking && !preview) selection.forEach((node, index) => {
      if (!node.isConnected) return;
      const box = el('div', { class: 'outline selected' }); box.append(el('span', { class: 'label' }, `✓ ${index + 1} · ${C.elementLabel(node)}`));
      drawRect(box, node); ui.layer.append(box);
    });
    ui.hover.hidden = preview || !hovered?.isConnected || !shown;
    if (!ui.hover.hidden) {
      drawRect(ui.hover, hovered); ui.hoverLabel.textContent = C.elementLabel(hovered);
      ui.hoverLabel.style.transform = hovered.getBoundingClientRect().top < 22 ? 'none' : 'translateY(-100%)';
    }
  }
  function scheduleDraw() {
    if (!frame && host) frame = requestAnimationFrame(() => { frame = 0; draw(); });
  }
  function keyboard(event) {
    if (!picking || saving || helperHidden) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); cancelPicking(); return; }
    if (event.composedPath().includes(host) && ['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SUMMARY'].includes(shadow.activeElement?.tagName)) return;
    if (event.ctrlKey || event.metaKey || event.altKey || event.key === 'Tab') return;
    event.stopImmediatePropagation();
    if (['Enter', ' ', '+', '=', '-', '_', '[', ']'].includes(event.key)) {
      event.preventDefault();
      if (event.key === 'Enter') savePicking();
      else if (event.key === ' ') toggleHovered();
      else if (['+', '='].includes(event.key)) chooseParent();
      else if (['-', '_'].includes(event.key)) chooseChild();
      else cycleLayer(event.key === ']' ? 1 : -1);
    }
  }
  async function switchMode(name) {
    if (saving || (picking && draftMode === name)) return;
    if (!picking && C.getMode(profile, name) && !drafts[name]?.dirty) {
      saving = true; render();
      try {
        const result = await message({ type: 'VB_PAGE_ACTIVATE_MODE', mode: name });
        profile = C.normalizeProfile(result.profile); saving = false; applyProfile();
      } catch (error) { saving = false; render(error.message, true); }
      return;
    }
    startPicking(name, true);
  }
  function startPicking(requestedMode, previewSaved = false) {
    if (requestedMode !== undefined && !['keep', 'hide'].includes(requestedMode)) throw new Error('Неизвестный режим выбора.');
    ensureUI(); revealHelper();
    const targetMode = requestedMode || (picking ? draftMode : C.profileMode(profile));
    if (picking) {
      rememberDraft();
    } else previousFocus = document.activeElement;
    draftMode = targetMode;
    loadDraft(draftMode, previewSaved);
    if (!previewSaved) preview = false;
    hovered = rawHovered = point = null; candidates = []; renderLayers();
    picking = true; saving = false; applyProfile(); bringToFront(true);
    ui.panel.focus({ preventScroll: true });
  }
  function endPicking(preserve = true) {
    if (preserve) rememberDraft();
    picking = preview = false; hovered = rawHovered = null;
    if (previousFocus?.isConnected && !ownNode(previousFocus)) previousFocus.focus?.({ preventScroll: true });
  }
  function cancelPicking() {
    if (saving) return;
    drafts[draftMode] = null; endPicking(false); applyProfile();
  }
  function revealHelper() {
    const wasHidden = helperHidden;
    helperHidden = false; helperPrefInitialized = true; collapsed = false;
    if (wasHidden) chrome.storage.local.set({ [helperStorageKey]: { hidden: false } })
      .catch(() => render('Окно открыто. Не удалось запомнить его видимость.', true));
  }
  async function setHelperVisibility(visible) {
    if (typeof visible !== 'boolean') throw new Error('Не указана видимость помощника.');
    if (saving) throw new Error('Дождитесь завершения сохранения.');
    await chrome.storage.local.set({ [helperStorageKey]: { hidden: !visible } });
    helperHidden = !visible; helperPrefInitialized = true;
    if (visible) {
      collapsed = false;
      if (!profile && !picking) { startPicking(); return; }
    }
    // Keep an unfinished selection in memory, but release the page and apply
    // its saved profile while the entire helper (including its mask) is hidden.
    applyProfile();
    if (visible) bringToFront(true);
  }
  async function message(data) {
    let health;
    try { health = await chrome.runtime.sendMessage({ type: 'VB_HEALTH' }); }
    catch { throw new Error(UPDATE_REQUIRED); }
    if (!health?.ok || health.protocol !== PROTOCOL) throw new Error(UPDATE_REQUIRED);
    const response = await chrome.runtime.sendMessage(data);
    if (!response?.ok) throw new Error(response?.error || 'Откройте ViewBlock заново в панели Chrome.');
    return response;
  }
  async function savePicking() {
    if (!picking || saving || helperHidden || (!selection.length && draftMode !== 'hide')) return;
    try {
      if (draftMode === 'hide') restore();
      refreshSelection();
      if (selection.some(node => !node.isConnected)) throw new Error('Страница обновилась. Выберите исчезнувшие блоки заново.');
      const selections = selection.map(node => C.describeElement(node, document, draftMode));
      applyProfile();
      saving = true; render('Сохраняем выбор…');
      const result = await message({ type: 'VB_SAVE', mode: draftMode, selections });
      profile = C.normalizeProfile(result.profile);
      if (!profile) throw new Error('Не удалось подтвердить сохранение. Откройте ViewBlock заново.');
      drafts[draftMode] = null; saving = false;
      endPicking(false); applyProfile();
    } catch (error) { saving = false; applyProfile(); render(error.message || String(error), true); }
  }
  async function toggleEnabled(enabled) {
    try {
      const result = await message({ type: 'VB_PAGE_TOGGLE', enabled });
      profile = C.normalizeProfile(result.profile); applyProfile();
    }
    catch (error) { restore(); render(error.message, true); }
  }
  function showFull() {
    if (picking) { preview = false; hovered = null; applyProfile(); }
    else toggleEnabled(false);
  }
  const ready = Promise.all([chrome.storage.local.get(storageKey), chrome.storage.local.get(helperStorageKey)]).then(([data, helperData]) => {
    if (!initialized) profile = C.normalizeProfile(data[storageKey]);
    if (!helperPrefInitialized) helperHidden = helperData[helperStorageKey]?.hidden === true;
    ensureUI(); observe(); applyProfile(); initialized = true;
  }).catch(error => { console.warn('ViewBlock:', error); restore(); });
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!['VB_STATUS', 'VB_PICK', 'VB_SET_HELPER_VISIBILITY', 'VB_RESET_LOCAL', 'VB_APPLY_SAVED'].includes(message?.type) || sender.id !== chrome.runtime.id) return;
    ready.then(async () => {
      if (message.type === 'VB_APPLY_SAVED') {
        // Chrome emits no storage event for an identical value. Explicit mode
        // activation still has to leave editing and restore the saved result.
        if (picking) endPicking();
        const data = await chrome.storage.local.get(storageKey);
        profile = C.normalizeProfile(data[storageKey]); applyProfile();
      }
      if (message.type === 'VB_RESET_LOCAL') {
        drafts.keep = drafts.hide = null; profile = null; endPicking(false);
        selection = []; selectionHints.clear(); resizeHistory.clear(); applyProfile();
      }
      if (message.type === 'VB_PICK') startPicking(message.mode);
      if (message.type === 'VB_SET_HELPER_VISIBILITY') await setHelperVisibility(message.visible);
      respond({ ok: true, protocol: PROTOCOL, helperVisible: shown, helperVisibilitySupported: true, picking, applied, missing, mode: mode(),
        editMode: picking ? draftMode : null, dirty: picking && dirty(), drafts: draftStates(),
        count: picking ? selection.length : profile?.selections?.length || 0 });
    }).catch(error => respond({ ok: false, error: error.message || String(error) }));
    return true;
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const profileChanged = Object.hasOwn(changes, storageKey), helperChanged = Object.hasOwn(changes, helperStorageKey);
    if (!profileChanged && !helperChanged) return;
    if (helperChanged) {
      helperPrefInitialized = true; helperHidden = changes[helperStorageKey].newValue?.hidden === true;
      if (!helperHidden) collapsed = false;
    }
    if (profileChanged) {
      // A saved result may be activated by the popup or another tab. Keep local
      // unsaved work separate; a profile update must not erase either draft.
      if (!saving && picking) endPicking();
      initialized = true; profile = C.normalizeProfile(changes[storageKey].newValue);
      for (const name of ['keep', 'hide']) if (!profile || !drafts[name]?.dirty) drafts[name] = null;
    }
    applyProfile();
  });
  window.addEventListener('pageshow', schedule);
  window.addEventListener('popstate', schedule);
  window.addEventListener('hashchange', schedule);
})();
