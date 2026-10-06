'use strict';
const $ = id => document.getElementById(id);
const PROTOCOL = 4;
const UPDATE_REQUIRED = 'Перезагрузите ViewBlock в chrome://extensions (круглая стрелка на карточке), затем обновите вкладку сайта.';
let tabId, site, profile, state = {}, currentMode = 'keep', busy = false, helperVisible = false;
function errorText(error) {
  const text = error.message || String(error);
  if (/Cannot access|Missing host permission|The extensions gallery|Cannot read properties/.test(text)) return 'Chrome не разрешил доступ к этой странице. Откройте обычный сайт и попробуйте снова.';
  return text;
}
async function send(type, extra = {}) {
  let health;
  try { health = await chrome.runtime.sendMessage({ type: 'VB_HEALTH' }); }
  catch { throw new Error(UPDATE_REQUIRED); }
  if (!health?.ok || health.protocol !== PROTOCOL) throw new Error(UPDATE_REQUIRED);
  if (type === 'VB_HELPER_VISIBILITY' && !health.capabilities?.includes('helperVisibility')) throw new Error(UPDATE_REQUIRED);
  const result = await chrome.runtime.sendMessage({ type, tabId, ...extra });
  if (!result?.ok) throw new Error(result?.error || 'Не удалось связаться с расширением.');
  return result;
}
function bank(mode) {
  if (profile?.modes) return profile.modes[mode] || null;
  return profile?.mode === mode ? { selections: profile.selections || [] } : null;
}
function hasSettings() { return Boolean(profile || state.drafts?.keep || state.drafts?.hide); }
function controls(disabled) {
  for (const id of ['pick', 'remove', 'edit', 'helper-toggle']) $(id).disabled = disabled || !site;
  $('toggle').disabled = disabled || !site || !profile;
  $('forget').disabled = disabled || !site || !hasSettings();
  $('forget-confirm').disabled = disabled || !site || !hasSettings();
  $('forget-cancel').disabled = disabled;
}
function closeReset() { $('reset-confirm').hidden = true; $('forget').hidden = false; }
function renderMode(mode, button, countId) {
  const saved = bank(mode), draft = state.drafts?.[mode];
  const dirty = Boolean(draft?.dirty);
  $(button).setAttribute('aria-pressed', String(currentMode === mode));
  $(countId).textContent = dirty ? `Черновик: ${draft.count || 0}` : saved ? `Сохранено: ${saved.selections.length}` : 'Не настроено';
  $(countId).classList.toggle('dirty', dirty);
  $(button).title = dirty ? 'Продолжить несохранённый выбор' : saved ? 'Применить сохранённый выбор' : 'Выбрать блоки для этого режима';
}
async function refresh() {
  const result = await send('VB_POPUP_STATUS');
  site = result.site; profile = result.profile; state = result.state || {};
  const picking = Boolean(state.picking);
  currentMode = (picking ? state.editMode || state.mode : profile?.mode) === 'hide' ? 'hide' : 'keep';
  const saved = bank(currentMode), draft = state.drafts?.[currentMode];
  const dirty = Boolean(draft?.dirty || (picking && state.dirty));
  const count = saved?.selections?.length || 0;
  const missing = Number.isInteger(state.missing) && state.missing > 0 ? state.missing : 0;
  helperVisible = Boolean(state.helperVisible);
  $('host').textContent = site.host;
  renderMode('keep', 'pick', 'keep-count'); renderMode('hide', 'remove', 'hide-count');
  $('status').textContent = picking ? helperVisible ? dirty ? 'Есть несохранённые изменения' : 'Выбор открыт на странице' : 'Выбор приостановлен'
    : !profile ? 'Начните с выбора блоков' : !profile.enabled ? 'Показана полная страница'
    : missing ? currentMode === 'hide' ? 'Часть блоков не найдена' : 'Выбор нужно уточнить'
    : currentMode === 'hide' ? count ? 'Выбранные блоки скрыты' : 'Ничего не скрывается' : 'Показаны выбранные блоки';
  $('detail').textContent = picking ? helperVisible ? dirty ? 'Проверьте результат и нажмите «Сохранить» в помощнике.' : 'Измените выбор в помощнике. Второй режим останется сохранённым.' : 'Черновик сохранён в этой вкладке. Покажите помощник, чтобы продолжить.'
    : !profile ? 'Выберите режим, затем отметьте области страницы.' : !profile.enabled ? 'Сохранённый выбор можно включить снова.'
    : missing ? currentMode === 'hide' ? `Не найдено: ${missing}. Остальные выбранные блоки скрыты.` : 'Показана полная страница: часть выбранных блоков исчезла.'
    : currentMode === 'hide' ? count ? 'Остальная страница остаётся видимой.' : 'Добавьте блоки, которые хотите скрыть.' : 'Для другого вида страницы переключите режим выше.';
  $('lamp').className = 'lamp' + (picking || missing ? ' warn' : profile?.enabled ? ' on' : '');
  $('edit-label').textContent = dirty ? 'Продолжить выбор' : saved || picking ? 'Изменить выбор' : 'Выбрать блоки';
  $('helper-toggle').textContent = helperVisible ? 'Скрыть помощник' : 'Показать помощник';
  $('toggle').textContent = profile?.enabled ? 'Показать полную страницу' : 'Применить сохранённый выбор';
  if (!hasSettings()) closeReset();
  controls(false);
}
async function run(action) {
  if (busy) return;
  busy = true; controls(true); $('error').hidden = true;
  try { await action(); } catch (error) { $('error').textContent = errorText(error); $('error').hidden = false; }
  finally { busy = false; controls(false); }
}
// Request only the current host, in the user's click handler.
async function requestSite() {
  const granted = await chrome.permissions.request({ origins: [site.pattern] });
  if (!granted) throw new Error('Доступ к сайту не разрешён. Настройки остались без изменений.');
}
async function chooseMode(mode) {
  await requestSite();
  if (!state.drafts?.[mode]?.dirty && bank(mode)) {
    await send('VB_ACTIVATE_MODE', { mode }); closeReset(); await refresh();
  } else {
    await send('VB_START', { mode }); window.close();
  }
}
$('pick').addEventListener('click', () => run(() => chooseMode('keep')));
$('remove').addEventListener('click', () => run(() => chooseMode('hide')));
$('edit').addEventListener('click', () => run(async () => {
  await requestSite(); await send('VB_START', { mode: currentMode }); window.close();
}));
$('helper-toggle').addEventListener('click', () => run(async () => {
  await send('VB_HELPER_VISIBILITY', { visible: !helperVisible }); await refresh();
}));
$('toggle').addEventListener('click', () => run(async () => {
  if (!profile.enabled) await requestSite();
  await send('VB_TOGGLE', { enabled: !profile.enabled }); await refresh();
}));
$('forget').addEventListener('click', () => { $('forget').hidden = true; $('reset-confirm').hidden = false; $('forget-cancel').focus(); });
$('forget-cancel').addEventListener('click', () => { closeReset(); $('forget').focus(); });
$('forget-confirm').addEventListener('click', () => run(async () => { await send('VB_FORGET'); closeReset(); await refresh(); }));
(async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    tabId = tab?.id; site = ViewBlockCore.siteFromUrl(tab?.url);
    await refresh();
  } catch (error) {
    site = null; $('host').textContent = 'Страница недоступна'; $('status').textContent = 'Откройте сайт';
    $('detail').textContent = errorText(error); controls(true);
  }
})();
