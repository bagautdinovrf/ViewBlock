'use strict';
importScripts('core.js');
const C = ViewBlockCore;
// Keep this in the executing file: a newer core.js does not update an old worker.
const PROTOCOL = 4;
const UPDATE_REQUIRED = 'Перезагрузите ViewBlock в chrome://extensions (круглая стрелка на карточке), затем обновите вкладку сайта.';
let registrationQueue = Promise.resolve();
const profileQueues = new Map();

function enqueueProfileMutation(origin, mutate) {
  const previous = profileQueues.get(origin) ?? Promise.resolve();
  const task = previous.catch(() => {}).then(mutate);
  profileQueues.set(origin, task);
  const cleanup = () => { if (profileQueues.get(origin) === task) profileQueues.delete(origin); };
  task.then(cleanup, cleanup);
  return task;
}
async function updateProfile(origin, transform) {
  const key = C.keyFor(origin);
  const stored = await chrome.storage.local.get(key);
  const profile = transform(C.normalizeProfile(stored[key]));
  if (profile) await chrome.storage.local.set({ [key]: profile });
  return profile;
}

async function registerSite(origin) {
  const { pattern } = C.siteFromUrl(origin);
  if (!await chrome.permissions.contains({ origins: [pattern] })) return;
  const id = C.scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (!existing.length) await chrome.scripting.registerContentScripts([{
    id, matches: [pattern], js: ['core.js', 'content.js'], runAt: 'document_idle', persistAcrossSessions: true
  }]);
}
function enqueueRegistration(origin) {
  registrationQueue = registrationQueue.catch(() => {}).then(() => registerSite(origin));
  return registrationQueue;
}
async function ensureContent(tabId) {
  let state;
  try { state = await chrome.tabs.sendMessage(tabId, { type: 'VB_STATUS' }); }
  catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['core.js', 'content.js'] });
    state = await chrome.tabs.sendMessage(tabId, { type: 'VB_STATUS' });
  }
  if (state?.protocol !== PROTOCOL) throw new Error(UPDATE_REQUIRED);
  return state;
}
async function applySaved(tabId) {
  const result = await chrome.tabs.sendMessage(tabId, { type: 'VB_APPLY_SAVED' });
  if (!result?.ok) throw new Error(result?.error || UPDATE_REQUIRED);
}
function isPopupUrl(value) {
  try {
    const actual = new URL(value), expected = new URL(chrome.runtime.getURL('popup.html'));
    return actual.protocol === expected.protocol && actual.host === expected.host && actual.pathname === expected.pathname;
  } catch { return false; }
}
async function isPopupSender(sender) {
  // A genuine extension UI can also be opened in a tab. Authenticate its URL,
  // not the presence/absence of tab metadata; webpage content scripts still fail.
  if (sender.url !== undefined) return isPopupUrl(sender.url);
  if (!sender.documentId || typeof chrome.runtime.getContexts !== 'function') return false;
  const contexts = await chrome.runtime.getContexts({ documentIds: [sender.documentId] });
  return contexts.some(context => context.documentId === sender.documentId &&
    ['POPUP', 'TAB'].includes(context.contextType) && isPopupUrl(context.documentUrl));
}
async function reconcile() {
  const records = await chrome.storage.local.get(null);
  const scripts = await chrome.scripting.getRegisteredContentScripts();
  const wanted = new Set();
  for (const [key, profile] of Object.entries(records)) {
    if (!key.startsWith(C.PREFIX)) continue;
    try {
      const origin = key.slice(C.PREFIX.length);
      const { pattern } = C.siteFromUrl(origin);
      if (await chrome.permissions.contains({ origins: [pattern] })) {
        wanted.add(C.scriptId(origin));
        await enqueueRegistration(origin);
      } else if (profile.enabled) {
        await enqueueProfileMutation(origin, () => updateProfile(origin, current => current ? { ...current, enabled: false } : null));
      }
    } catch (error) { console.warn('ViewBlock profile:', error); }
  }
  const obsolete = scripts.filter(s => s.id.startsWith('vb-') && !wanted.has(s.id)).map(s => s.id);
  if (obsolete.length) await chrome.scripting.unregisterContentScripts({ ids: obsolete });
}
async function route(message, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Недопустимый отправитель.');
  // Read-only handshake works for both our popup and our content scripts.
  if (message?.type === 'VB_HEALTH') return { ok: true, protocol: PROTOCOL, version: '1.5.0', capabilities: ['helperVisibility', 'independentModes', 'relativeHiding'] };
  if (['VB_SAVE', 'VB_PAGE_TOGGLE', 'VB_PAGE_ACTIVATE_MODE'].includes(message.type)) {
    if (!sender.tab || sender.frameId !== 0) throw new Error('Недопустимая вкладка.');
    const { origin } = C.siteFromUrl(sender.url);
    let profile;
    if (message.type === 'VB_SAVE') {
      if (message.mode !== undefined && !['keep', 'hide'].includes(message.mode)) throw new Error('Неизвестный режим выбора.');
      const mode = message.mode ?? 'keep';
      const selections = mode === 'hide' && message.selections === undefined ? [] : message.selections;
      // Validate before changing registration, then merge against the latest
      // stored profile inside the origin queue. Two tabs cannot erase a bank.
      C.saveMode(null, mode, selections);
      profile = await enqueueProfileMutation(origin, async () => {
        await enqueueRegistration(origin);
        return updateProfile(origin, current => C.saveMode(current, mode, selections));
      });
    } else if (message.type === 'VB_PAGE_ACTIVATE_MODE') {
      if (!['keep', 'hide'].includes(message.mode)) throw new Error('Неизвестный режим выбора.');
      profile = await enqueueProfileMutation(origin, async () => {
        await enqueueRegistration(origin);
        return updateProfile(origin, current => C.activateMode(current, message.mode));
      });
    } else {
      profile = await enqueueProfileMutation(origin, () => updateProfile(origin,
        current => current ? { ...current, enabled: Boolean(message.enabled) } : null));
    }
    return { ok: true, profile };
  }
  // Only our popup may control arbitrary tab IDs.
  if (!await isPopupSender(sender)) throw new Error('Недопустимый интерфейс.');
  if (!['VB_POPUP_STATUS', 'VB_START', 'VB_TOGGLE', 'VB_ACTIVATE_MODE', 'VB_FORGET', 'VB_HELPER_VISIBILITY'].includes(message.type)) throw new Error('Неизвестная команда.');
  if ((message.type === 'VB_START' && message.mode !== undefined || message.type === 'VB_ACTIVATE_MODE') &&
      !['keep', 'hide'].includes(message.mode)) throw new Error('Неизвестный режим выбора.');
  if (!Number.isInteger(message.tabId)) throw new Error('Вкладка не найдена.');
  const tab = await chrome.tabs.get(message.tabId);
  const site = C.siteFromUrl(tab.url);
  const key = C.keyFor(site.origin);
  const stored = await chrome.storage.local.get(key);
  const savedProfile = C.normalizeProfile(stored[key]);
  if (message.type === 'VB_HELPER_VISIBILITY') {
    if (typeof message.visible !== 'boolean') throw new Error('Не указана видимость помощника.');
    const state = await ensureContent(tab.id);
    if (state.helperVisibilitySupported !== true) throw new Error(UPDATE_REQUIRED);
    const result = await chrome.tabs.sendMessage(tab.id, { type: 'VB_SET_HELPER_VISIBILITY', visible: message.visible });
    if (!result?.ok) throw new Error(result?.error || UPDATE_REQUIRED);
    return { ok: true, state: result };
  }
  if (message.type === 'VB_POPUP_STATUS') {
    const state = await ensureContent(tab.id);
    return { ok: true, site, profile: savedProfile, state };
  }
  if (message.type === 'VB_START') {
    await enqueueRegistration(site.origin);
    await ensureContent(tab.id);
    await chrome.tabs.sendMessage(tab.id, { type: 'VB_PICK', ...(message.mode === undefined ? {} : { mode: message.mode }) });
  }
  if (message.type === 'VB_TOGGLE') {
    await ensureContent(tab.id);
    const profile = await enqueueProfileMutation(site.origin, async () => {
      await enqueueRegistration(site.origin);
      const saved = await updateProfile(site.origin, current => {
        if (!current) throw new Error('Сначала выберите блоки.');
        return { ...current, enabled: Boolean(message.enabled) };
      });
      await applySaved(tab.id);
      return saved;
    });
    return { ok: true, profile };
  }
  if (message.type === 'VB_ACTIVATE_MODE') {
    await ensureContent(tab.id);
    const profile = await enqueueProfileMutation(site.origin, async () => {
      await enqueueRegistration(site.origin);
      const saved = await updateProfile(site.origin, current => C.activateMode(current, message.mode));
      // Activating the already-saved mode can leave storage unchanged. The
      // current tab must still exit its editor and display that saved result.
      await applySaved(tab.id);
      return saved;
    });
    return { ok: true, profile };
  }
  if (message.type === 'VB_FORGET') {
    await ensureContent(tab.id);
    await enqueueProfileMutation(site.origin, async () => {
      await chrome.storage.local.remove(key);
      registrationQueue = registrationQueue.catch(() => {}).then(async () => {
        const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: [C.scriptId(site.origin)] });
        if (scripts.length) await chrome.scripting.unregisterContentScripts({ ids: [C.scriptId(site.origin)] });
      });
      await registrationQueue;
      // Removing a missing key does not emit onChanged. A first, unsaved
      // choice still needs to be cleared explicitly in this tab.
      let reset;
      try { reset = await chrome.tabs.sendMessage(tab.id, { type: 'VB_RESET_LOCAL' }); }
      catch { throw new Error('Настройки удалены. Обновите страницу, чтобы закрыть незавершённый выбор.'); }
      if (!reset?.ok) throw new Error(reset?.error || UPDATE_REQUIRED);
    });
    return { ok: true, profile: null };
  }
  return { ok: true };
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  route(message, sender).then(respond).catch(error => respond({ ok: false, error: error.message || String(error) }));
  return true;
});
chrome.runtime.onInstalled.addListener(() => { reconcile().catch(console.warn); });
chrome.runtime.onStartup.addListener(() => { reconcile().catch(console.warn); });
chrome.permissions.onRemoved.addListener(() => { reconcile().catch(console.warn); });
