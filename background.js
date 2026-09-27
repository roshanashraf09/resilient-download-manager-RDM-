// Background service worker: routes messages, owns task storage, saves finished files,
// and keeps the offscreen download engine alive while downloads run.
import { db } from './db.js';

let creatingOffscreen = null;

async function ensureOffscreenDocument() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length > 0) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS', 'WORKERS'],
      justification: 'Chunked downloading with pause/resume and assembling the finished file'
    }).finally(() => { creatingOffscreen = null; });
  }
  await creatingOffscreen;
}

function sendToOffscreen(message) {
  return chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
}

function notify(title, message) {
  chrome.notifications.create({ type: 'basic', iconUrl: 'icons/icon128.png', title, message: message.slice(0, 250) });
}

// ------------------------------------------------------------------ keepalive / crash recovery

// 30s is the shortest alarm Chrome allows. If downloads were running and the offscreen
// document is gone (browser restart, crash), recreating it makes it auto-resume them.
chrome.alarms.create('rdm_keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'rdm_keepalive') return;
  const tasks = await db.getAllTasks();
  if (tasks.some(t => t.status === 'downloading' || t.status === 'assembling')) {
    await ensureOffscreenDocument();
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const tasks = await db.getAllTasks();
  if (tasks.some(t => t.status === 'downloading' || t.status === 'assembling')) {
    await ensureOffscreenDocument();
  }
});

// ------------------------------------------------------------------ context menus

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'rdm_download_link', title: 'Download with Resilient Downloader', contexts: ['link', 'video', 'audio', 'image'] });
    chrome.contextMenus.create({ id: 'rdm_inspect_link', title: 'Check resume support for this link', contexts: ['link'] });
    chrome.contextMenus.create({ id: 'rdm_open_dashboard', title: 'Open Download Manager Dashboard', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  const url = info.linkUrl || info.srcUrl;
  if (info.menuItemId === 'rdm_download_link' && url) {
    try {
      await ensureOffscreenDocument();
      const task = await sendToOffscreen({ type: 'CREATE_TASK', url, autoStart: true });
      if (task?.error) throw new Error(task.error);
      notify('Download started', task.filename);
    } catch (err) {
      notify('Download failed to start', err.message || String(err));
    }
  } else if (info.menuItemId === 'rdm_inspect_link' && url) {
    await ensureOffscreenDocument();
    const probe = await sendToOffscreen({ type: 'INSPECT_LINK', url });
    const size = probe.contentLength ? ` (${(probe.contentLength / 1048576).toFixed(2)} MB)` : '';
    const status = probe.error ? `Error: ${probe.error}`
      : probe.supportsResume ? '✅ Resumable (byte ranges supported)' : '⚠️ Not resumable: single stream only';
    notify('Link check', `${probe.filename}${size}\n${status}`);
  } else if (info.menuItemId === 'rdm_open_dashboard') {
    chrome.runtime.openOptionsPage();
  }
});

// ------------------------------------------------------------------ messages

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || request.target === 'offscreen') return false;

  // Task storage requests from the offscreen engine
  if (request.target === 'background_storage') {
    (async () => {
      if (request.action === 'getAll') return db.getAllTasks();
      if (request.action === 'save') return db.saveTask(request.task);
      if (request.action === 'delete') return db.deleteTask(request.id);
      return null;
    })().then(sendResponse).catch(err => sendResponse({ error: err.message }));
    return true;
  }

  const handle = async () => {
    switch (request.type) {
      // Offscreen engine finished assembling a file: hand it to Chrome's downloader
      case 'SAVE_FILE': {
        const downloadId = await chrome.downloads.download({
          url: request.blobUrl,
          filename: request.filename,
          conflictAction: 'uniquify',
          saveAs: false
        });
        blobDownloads.set(downloadId, request.taskId);
        return { downloadId };
      }

      case 'INSPECT_LINK':
      case 'CREATE_TASK':
      case 'START_TASK':
      case 'PAUSE_TASK':
      case 'CANCEL_TASK':
      case 'UPDATE_TASK_URL':
        await ensureOffscreenDocument();
        if (request.taskId) {
          const task = (await db.getAllTasks()).find(t => t.id === request.taskId);
          if (task?.referrer) await setReferrerRule(request.newUrl || task.url, task.referrer);
        }
        return sendToOffscreen(request);

      case 'GET_ALL_CUSTOM_TASKS':
        return db.getAllTasks();

      case 'CLEAR_FINISHED': {
        const tasks = await db.getAllTasks();
        for (const t of tasks.filter(t => t.status === 'completed')) await db.deleteTask(t.id);
        return { success: true };
      }

      case 'GET_NATIVE_DOWNLOADS':
        return chrome.downloads.search({ orderBy: ['-startTime'], limit: 50 });
      case 'PAUSE_NATIVE':
        await chrome.downloads.pause(request.downloadId);
        return { success: true };
      case 'RESUME_NATIVE':
        await chrome.downloads.resume(request.downloadId);
        return { success: true };
      case 'CANCEL_NATIVE':
        await chrome.downloads.cancel(request.downloadId);
        return { success: true };
      case 'ERASE_NATIVE':
        await chrome.downloads.erase({ id: request.downloadId });
        return { success: true };
      case 'OPEN_NATIVE_FILE':
        chrome.downloads.open(request.downloadId);
        return { success: true };
      case 'SHOW_NATIVE_FILE':
        chrome.downloads.show(request.downloadId);
        return { success: true };
      case 'OPEN_DASHBOARD':
        chrome.runtime.openOptionsPage();
        return { success: true };

      default:
        return undefined; // not for us (e.g. broadcasts between pages)
    }
  };

  // Only claim the response channel for messages we handle
  const known = ['SAVE_FILE', 'INSPECT_LINK', 'CREATE_TASK', 'START_TASK', 'PAUSE_TASK', 'CANCEL_TASK',
    'UPDATE_TASK_URL', 'GET_ALL_CUSTOM_TASKS', 'CLEAR_FINISHED', 'GET_NATIVE_DOWNLOADS', 'PAUSE_NATIVE',
    'RESUME_NATIVE', 'CANCEL_NATIVE', 'ERASE_NATIVE', 'OPEN_NATIVE_FILE', 'SHOW_NATIVE_FILE', 'OPEN_DASHBOARD'];
  if (!known.includes(request.type)) return false;
  handle().then(sendResponse).catch(err => sendResponse({ error: err.message || String(err) }));
  return true;
});

// ------------------------------------------------------------------ finished-file tracking

// downloadId -> taskId for files we saved from a blob. If the worker restarts and loses this,
// the task's own downloadId (saved by the engine) is used instead.
const blobDownloads = new Map();

chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  const tasks = await db.getAllTasks();
  const task = tasks.find(t => t.downloadId === delta.id) ||
    (blobDownloads.has(delta.id) ? tasks.find(t => t.id === blobDownloads.get(delta.id)) : null);
  if (!task) return;
  blobDownloads.delete(delta.id);

  // Chrome has finished copying the blob to disk; the offscreen doc can free the memory
  // (on success it also deletes the cached chunks; on failure they're kept so Retry can re-save)
  sendToOffscreen({ type: 'RELEASE_BLOB', downloadId: delta.id, ok: state === 'complete' }).catch(() => {});

  if (state === 'complete') {
    notify('Download complete', task.filename);
  } else {
    const [item] = await chrome.downloads.search({ id: delta.id });
    task.status = 'error';
    task.errorMessage = `Saving to disk failed: ${item?.error || 'interrupted'}`;
    task.updatedAt = Date.now();
    await db.saveTask(task);
    notify('Saving failed', `${task.filename}: ${item?.error || 'interrupted'}`);
  }
});

// ------------------------------------------------------------------ settings

const DEFAULT_SETTINGS = {
  captureEnabled: true,      // take over normal browser downloads
  minSizeMB: 1,              // leave smaller files to Chrome
  excludedDomains: [],       // never capture from these sites
  connections: 4,
  chunkSizeMB: 4
};

async function getSettings() {
  const { rdm_settings } = await chrome.storage.local.get('rdm_settings');
  return { ...DEFAULT_SETTINGS, ...(rdm_settings || {}) };
}

function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch (e) { return ''; }
}

function isExcluded(host, excluded) {
  return excluded.some(d => {
    const dom = d.trim().toLowerCase().replace(/^\*\./, '');
    return dom && (host === dom || host.endsWith('.' + dom));
  });
}

// ------------------------------------------------------------------ capturing browser downloads
//
// When Chrome starts a download we pause it and probe the link. Only if the server supports
// byte ranges (so we can do better than Chrome: parallel connections, resume, crash recovery)
// do we cancel Chrome's copy and take over. Anything else (POST forms, one-time links, tiny
// files, servers without range support) is resumed in Chrome untouched, so nothing is lost.

const captureInProgress = new Set();

chrome.downloads.onCreated.addListener((item) => {
  maybeCapture(item).catch(err => console.warn('Capture check failed:', err));
});

async function maybeCapture(item) {
  const url = item.finalUrl || item.url;
  if (!/^https?:/i.test(url)) return;           // blob:/data: (includes our own saved files)
  if (item.byExtensionId) return;                // started by an extension (us or another one)
  if (item.incognito) return;                    // our requests wouldn't carry incognito cookies
  if (item.state !== 'in_progress') return;
  if (captureInProgress.has(item.id)) return;

  const settings = await getSettings();
  if (!settings.captureEnabled) return;
  if (isExcluded(hostOf(url), settings.excludedDomains)) return;

  captureInProgress.add(item.id);
  let paused = false;
  const giveBack = async (reason) => {
    console.info(`Leaving download to Chrome (${reason}):`, url);
    if (paused) await chrome.downloads.resume(item.id).catch(() => {});
  };

  try {
    await chrome.downloads.pause(item.id).then(() => { paused = true; }).catch(() => {});

    await ensureOffscreenDocument();
    if (item.referrer) await setReferrerRule(url, item.referrer);
    const probe = await sendToOffscreen({ type: 'INSPECT_LINK', url });
    const minBytes = settings.minSizeMB * 1024 * 1024;
    if (!probe || !probe.valid) return giveBack(probe?.error || 'probe failed');
    if (!probe.supportsResume) return giveBack('server has no range support');
    if (probe.contentLength < minBytes) return giveBack('smaller than minimum size');

    // Chrome may have worked out a better name (e.g. from the page's download attribute)
    const [current] = await chrome.downloads.search({ id: item.id });
    const chromeName = current?.filename ? current.filename.split(/[/\\]/).pop() : '';
    const task = await sendToOffscreen({
      type: 'CREATE_TASK',
      url,
      filename: chromeName || null,
      referrer: item.referrer || null,
      connections: settings.connections,
      chunkSizeMB: settings.chunkSizeMB,
      autoStart: true
    });
    if (!task || task.error) return giveBack(task?.error || 'could not create task');

    await chrome.downloads.cancel(item.id).catch(() => {});
    await chrome.downloads.erase({ id: item.id }).catch(() => {});
    notify('Download taken over', `${task.filename} (${(probe.contentLength / 1048576).toFixed(1)} MB) is downloading with ${settings.connections} connections`);
  } catch (err) {
    await giveBack(err.message || String(err));
  } finally {
    captureInProgress.delete(item.id);
  }
}

// ------------------------------------------------------------------ Referer header
//
// Many file hosts refuse downloads without the page's Referer. fetch() can't set it, so a
// session rule adds it to our own (tab-less) requests for that host.

let referrerRuleSync = Promise.resolve();

function ruleIdFor(host) {
  let h = 0;
  for (const c of host) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 1000000) + 1;
}

function setReferrerRule(url, referrer) {
  const host = hostOf(url);
  if (!host || !referrer) return Promise.resolve();
  const id = ruleIdFor(host);
  referrerRuleSync = referrerRuleSync.then(() => chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [id],
    addRules: [{
      id,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'referer', operation: 'set', value: referrer }] },
      condition: { requestDomains: [host], tabIds: [chrome.tabs?.TAB_ID_NONE ?? -1] }
    }]
  })).catch(err => console.warn('Referer rule failed:', err));
  return referrerRuleSync;
}

// Session rules vanish when the browser closes, so rebuild them for unfinished tasks
async function syncReferrerRules() {
  const tasks = await db.getAllTasks();
  for (const t of tasks) {
    if (t.referrer && t.status !== 'completed') await setReferrerRule(t.url, t.referrer);
  }
}
chrome.runtime.onStartup.addListener(syncReferrerRules);
chrome.runtime.onInstalled.addListener(syncReferrerRules);
