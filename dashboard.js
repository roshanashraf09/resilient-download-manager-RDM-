// Dashboard Controller for Resilient Download Manager

let currentTab = 'downloads';
let customTasks = [];
let nativeTasks = [];
let selectedTaskIdForVisualizer = null;
let lastInspectedUrl = null;

function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(decimals)) + ' ' + sizes[i];
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec || bytesPerSec <= 0) return '0 KB/s';
  return formatBytes(bytesPerSec, 1) + '/s';
}

function formatEta(seconds) {
  if (!seconds || seconds <= 0 || !isFinite(seconds)) return '--:--';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  if (mins >= 60) {
    const hours = Math.floor(mins / 60);
    const remMins = mins % 60;
    return `${hours}h ${remMins}m`;
  }
  return `${mins}m ${secs.toString().padStart(2, '0')}s`;
}

async function loadData() {
  try {
    const [cTasks, nTasks] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ALL_CUSTOM_TASKS' }),
      chrome.runtime.sendMessage({ type: 'GET_NATIVE_DOWNLOADS' })
    ]);
    customTasks = Array.isArray(cTasks) ? cTasks : [];
    nativeTasks = Array.isArray(nTasks) ? nTasks : [];
    render();
  } catch (err) {
    console.error('Failed to load dashboard data:', err);
  }
}

function render() {
  const customNormalized = customTasks.map(t => ({
    id: t.id,
    isCustom: true,
    filename: t.filename || 'download.bin',
    url: t.url,
    totalBytes: t.totalBytes || 0,
    downloadedBytes: t.downloadedBytes || 0,
    status: t.status || 'queued',
    supportsResume: t.supportsResume || false,
    speed: t.speed || 0,
    eta: t.eta || 0,
    errorMessage: t.errorMessage,
    downloadId: t.downloadId,
    updatedAt: t.updatedAt || t.createdAt || Date.now(),
    completedChunks: t.completedChunks || [],
    totalChunks: t.totalChunks || 1
  }));

  const customDownloadIds = new Set(customTasks.map(t => t.downloadId).filter(Boolean));
  const nativeNormalized = nativeTasks
    .filter(t => !customDownloadIds.has(t.id) && !t.url.startsWith('blob:chrome-extension:'))
    .map(t => {
      let status = 'downloading';
      if (t.state === 'complete') status = 'completed';
      else if (t.state === 'interrupted') status = 'error';
      else if (t.paused) status = 'paused';

      return {
        id: t.id,
        isCustom: false,
        filename: t.filename ? t.filename.split(/[/\\]/).pop() : 'download',
        url: t.url,
        totalBytes: t.totalBytes > 0 ? t.totalBytes : (t.fileSize || 0),
        downloadedBytes: t.bytesReceived || 0,
        status,
        supportsResume: t.canResume || false,
        speed: t.bytesReceivedSpeed || 0,
        eta: t.estimatedEndTime ? Math.max(0, (new Date(t.estimatedEndTime) - Date.now()) / 1000) : 0,
        errorMessage: t.error,
        canResume: t.canResume,
        updatedAt: new Date(t.startTime).getTime()
      };
    });

  const allItems = [...customNormalized, ...nativeNormalized].sort((a, b) => b.updatedAt - a.updatedAt);

  const activeCount = allItems.filter(i => i.status === 'downloading').length;
  const pausedCount = allItems.filter(i => i.status === 'paused' || i.status === 'link_expired').length;
  const doneCount = allItems.filter(i => i.status === 'completed').length;

  const bAll = document.getElementById('badgeAll');
  const bAct = document.getElementById('badgeActive');
  const bPau = document.getElementById('badgePaused');
  const bCom = document.getElementById('badgeCompleted');

  if (bAll) bAll.textContent = allItems.length;
  if (bAct) bAct.textContent = activeCount;
  if (bPau) bPau.textContent = pausedCount;
  if (bCom) bCom.textContent = doneCount;

  const tbody = document.getElementById('downloadTableBody');
  const emptyState = document.getElementById('tableEmptyState');
  if (!tbody) return;

  let filtered = allItems;
  if (currentTab === 'active') filtered = allItems.filter(i => i.status === 'downloading');
  else if (currentTab === 'paused') filtered = allItems.filter(i => i.status === 'paused' || i.status === 'link_expired');
  else if (currentTab === 'completed') filtered = allItems.filter(i => i.status === 'completed');

  tbody.innerHTML = '';
  if (filtered.length === 0) {
    if (emptyState) emptyState.classList.remove('hidden');
  } else {
    if (emptyState) emptyState.classList.add('hidden');
    for (const item of filtered) {
      tbody.appendChild(createTableRow(item));
    }
  }

  if (selectedTaskIdForVisualizer) {
    const selectedTask = customNormalized.find(t => t.id === selectedTaskIdForVisualizer);
    if (selectedTask) {
      renderVisualizer(selectedTask);
    }
  }
}

function createTableRow(item) {
  const tr = document.createElement('tr');
  const percent = item.totalBytes > 0
    ? Math.min(100, Math.max(0, (item.downloadedBytes / item.totalBytes) * 100)).toFixed(1)
    : (item.status === 'completed' ? 100 : 0);

  let actions = '';
  if (item.isCustom) {
    if (item.status === 'downloading') {
      actions += `<button class="btn-tbl" data-action="custom-pause" data-id="${item.id}">Pause</button>`;
    } else if (item.status === 'paused') {
      actions += `<button class="btn-tbl" data-action="custom-resume" data-id="${item.id}">Resume</button>`;
      actions += `<button class="btn-tbl" data-action="refresh-link" data-id="${item.id}">Refresh Link</button>`;
    } else if (item.status === 'link_expired' || item.status === 'error') {
      actions += `<button class="btn-tbl" data-action="refresh-link" data-id="${item.id}">Fix Link</button>`;
      actions += `<button class="btn-tbl" data-action="custom-resume" data-id="${item.id}">Retry</button>`;
    } else if (item.status === 'queued') {
      actions += `<button class="btn-tbl" data-action="custom-resume" data-id="${item.id}">Start</button>`;
    } else if (item.status === 'completed' && item.downloadId) {
      actions += `<button class="btn-tbl" data-action="native-open" data-id="${item.downloadId}">Open</button>`;
      actions += `<button class="btn-tbl" data-action="native-show" data-id="${item.downloadId}">Show</button>`;
    }

    if (item.supportsResume && item.status !== 'completed') {
      actions += `<button class="btn-tbl" data-action="inspect-chunks" data-id="${item.id}">Visualizer</button>`;
    }
    actions += `<button class="btn-tbl" data-action="custom-cancel" data-id="${item.id}" style="color: var(--rose)" title="${item.status === 'completed' ? 'Remove from list (keeps the file)' : 'Cancel and delete'}">${item.status === 'completed' ? 'Remove' : 'Delete'}</button>`;
  } else {
    if (item.status === 'downloading') {
      actions += `<button class="btn-tbl" data-action="native-pause" data-id="${item.id}">Pause</button>`;
    } else if (item.status === 'paused') {
      actions += `<button class="btn-tbl" data-action="native-resume" data-id="${item.id}">Resume</button>`;
    } else if (item.status === 'error' && item.canResume) {
      actions += `<button class="btn-tbl" data-action="native-resume" data-id="${item.id}">Retry</button>`;
    } else if (item.status === 'completed') {
      actions += `<button class="btn-tbl" data-action="native-open" data-id="${item.id}">Open</button>`;
      actions += `<button class="btn-tbl" data-action="native-show" data-id="${item.id}">Show</button>`;
    }
    const finished = item.status === 'completed' || item.status === 'error';
    actions += `<button class="btn-tbl" data-action="${finished ? 'native-erase' : 'native-cancel'}" data-id="${item.id}" style="color: var(--rose)">${finished ? 'Remove' : 'Cancel'}</button>`;
  }

  tr.innerHTML = `
    <td>
      <div class="file-cell">
        <span class="file-name-text" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
      </div>
    </td>
    <td>${item.totalBytes > 0 ? formatBytes(item.totalBytes) : 'Unknown'}</td>
    <td>
      <div class="tbl-progress-bar">
        <div class="tbl-progress-fill" style="width: ${percent}%;"></div>
      </div>
      <span class="text-sm text-muted">${percent}% (${formatBytes(item.downloadedBytes)})</span>
    </td>
    <td>${item.status === 'downloading' ? formatSpeed(item.speed) : '-'}</td>
    <td>${item.status === 'downloading' ? formatEta(item.eta) : '-'}</td>
    <td>
      <span class="status-badge ${item.status}">${item.status.replace('_', ' ').toUpperCase()}</span>
    </td>
    <td>
      <span class="text-sm text-muted">${item.isCustom ? 'Resilient Chunked' : 'Native'}</span>
    </td>
    <td>
      ${actions}
    </td>
  `;

  tr.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      await handleAction(action, id);
    });
  });

  return tr;
}

function renderVisualizer(task) {
  const panel = document.getElementById('chunkVisualizerPanel');
  if (!panel) return;
  panel.classList.remove('hidden');

  document.getElementById('visFileName').textContent = task.filename;
  const completedCount = task.completedChunks.length;
  document.getElementById('visStats').textContent =
    `${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)} • ${completedCount} / ${task.totalChunks} chunks downloaded`;

  const grid = document.getElementById('chunkGrid');
  grid.innerHTML = '';

  const completedSet = new Set(task.completedChunks);

  for (let i = 0; i < task.totalChunks; i++) {
    const cell = document.createElement('div');
    cell.className = 'chunk-cell';
    if (completedSet.has(i)) {
      cell.classList.add('chunk-done');
      cell.title = `Chunk #${i + 1}: Downloaded`;
    } else if (task.status === 'downloading') {
      cell.classList.add('chunk-active');
      cell.title = `Chunk #${i + 1}: Downloading`;
    } else {
      cell.classList.add('chunk-pending');
      cell.title = `Chunk #${i + 1}: Pending`;
    }
    grid.appendChild(cell);
  }
}

async function handleAction(action, id) {
  switch (action) {
    case 'custom-pause':
      await chrome.runtime.sendMessage({ type: 'PAUSE_TASK', taskId: id });
      break;
    case 'custom-resume':
      await chrome.runtime.sendMessage({ type: 'START_TASK', taskId: id });
      break;
    case 'custom-cancel':
      await chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId: id });
      if (selectedTaskIdForVisualizer === id) {
        selectedTaskIdForVisualizer = null;
        const panel = document.getElementById('chunkVisualizerPanel');
        if (panel) panel.classList.add('hidden');
      }
      break;
    case 'inspect-chunks':
      selectedTaskIdForVisualizer = id;
      loadData();
      break;
    case 'refresh-link':
      openRefreshModal(id);
      break;
    case 'native-pause':
      await chrome.runtime.sendMessage({ type: 'PAUSE_NATIVE', downloadId: parseInt(id, 10) });
      break;
    case 'native-resume':
      await chrome.runtime.sendMessage({ type: 'RESUME_NATIVE', downloadId: parseInt(id, 10) });
      break;
    case 'native-cancel':
      await chrome.runtime.sendMessage({ type: 'CANCEL_NATIVE', downloadId: parseInt(id, 10) });
      break;
    case 'native-erase':
      await chrome.runtime.sendMessage({ type: 'ERASE_NATIVE', downloadId: parseInt(id, 10) });
      break;
    case 'native-open':
      await chrome.runtime.sendMessage({ type: 'OPEN_NATIVE_FILE', downloadId: parseInt(id, 10) });
      break;
    case 'native-show':
      await chrome.runtime.sendMessage({ type: 'SHOW_NATIVE_FILE', downloadId: parseInt(id, 10) });
      break;
  }
  await loadData();
}

function openRefreshModal(taskId) {
  const modal = document.getElementById('dashRefreshModal');
  document.getElementById('dashRefreshTaskId').value = taskId;
  document.getElementById('dashInputNewUrl').value = '';
  document.getElementById('dashRefreshError').classList.add('hidden');
  modal.classList.remove('hidden');
}

function setupEvents() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTab = btn.getAttribute('data-tab');

      const titleMap = {
        downloads: 'All Downloads',
        active: 'Active Downloads',
        paused: 'Paused & Expired Downloads',
        completed: 'Completed Downloads',
        inspector: 'Link Health Inspector',
        settings: 'Settings'
      };
      document.getElementById('pageTitle').textContent = titleMap[currentTab] || 'Downloads';

      const view = currentTab === 'inspector' ? 'tabInspectorView'
        : currentTab === 'settings' ? 'tabSettingsView' : 'tabDownloadsView';
      for (const id of ['tabDownloadsView', 'tabInspectorView', 'tabSettingsView']) {
        document.getElementById(id).classList.toggle('hidden', id !== view);
      }
      if (view === 'tabSettingsView') loadSettings();
      if (view === 'tabDownloadsView') render();
    });
  });

  const btnCloseVis = document.getElementById('btnCloseVisualizer');
  if (btnCloseVis) {
    btnCloseVis.addEventListener('click', () => {
      selectedTaskIdForVisualizer = null;
      document.getElementById('chunkVisualizerPanel').classList.add('hidden');
    });
  }

  const addModal = document.getElementById('dashAddModal');
  const btnNew = document.getElementById('btnNewDownload');
  if (btnNew && addModal) {
    btnNew.addEventListener('click', () => {
      addModal.classList.remove('hidden');
      document.getElementById('dashInputUrl').focus();
    });
  }

  const btnCloseAdd = document.getElementById('btnDashCloseAdd');
  const btnCancelAdd = document.getElementById('btnDashCancelAdd');
  if (btnCloseAdd) btnCloseAdd.addEventListener('click', () => addModal.classList.add('hidden'));
  if (btnCancelAdd) btnCancelAdd.addEventListener('click', () => addModal.classList.add('hidden'));

  const btnStartAdd = document.getElementById('btnDashStartAdd');
  if (btnStartAdd) {
    btnStartAdd.addEventListener('click', async () => {
      const url = document.getElementById('dashInputUrl').value.trim();
      const filename = document.getElementById('dashInputFilename').value.trim() || null;
      const chunkSizeMB = parseInt(document.getElementById('dashSelectChunkSize').value, 10) || 4;
      const connections = parseInt(document.getElementById('dashSelectConnections').value, 10) || 4;

      if (!url) return alert('Please enter a valid URL');

      try {
        const res = await chrome.runtime.sendMessage({
          type: 'CREATE_TASK',
          url,
          filename,
          chunkSizeMB,
          connections,
          autoStart: true
        });
        if (res && res.error) throw new Error(res.error);
        addModal.classList.add('hidden');
        document.getElementById('dashInputUrl').value = '';
        document.getElementById('dashInputFilename').value = '';
        await loadData();
      } catch (err) {
        alert('Failed to start: ' + err.message);
      }
    });
  }

  const refreshModal = document.getElementById('dashRefreshModal');
  const btnCloseRef = document.getElementById('btnDashCloseRefresh');
  const btnCancelRef = document.getElementById('btnDashCancelRefresh');
  if (btnCloseRef) btnCloseRef.addEventListener('click', () => refreshModal.classList.add('hidden'));
  if (btnCancelRef) btnCancelRef.addEventListener('click', () => refreshModal.classList.add('hidden'));

  const btnConfirmRef = document.getElementById('btnDashConfirmRefresh');
  if (btnConfirmRef) {
    btnConfirmRef.addEventListener('click', async () => {
      const taskId = document.getElementById('dashRefreshTaskId').value;
      const newUrl = document.getElementById('dashInputNewUrl').value.trim();
      const errorEl = document.getElementById('dashRefreshError');

      if (!newUrl) {
        errorEl.textContent = 'Please enter a URL';
        errorEl.classList.remove('hidden');
        return;
      }

      try {
        errorEl.classList.add('hidden');
        const res = await chrome.runtime.sendMessage({ type: 'UPDATE_TASK_URL', taskId, newUrl });
        if (res && res.error) throw new Error(res.error);

        await chrome.runtime.sendMessage({ type: 'START_TASK', taskId });
        refreshModal.classList.add('hidden');
        await loadData();
      } catch (err) {
        errorEl.textContent = err.message || 'Failed to update URL';
        errorEl.classList.remove('hidden');
      }
    });
  }

  const btnRun = document.getElementById('btnRunInspection');
  if (btnRun) {
    btnRun.addEventListener('click', async () => {
      const url = document.getElementById('inspectorInputUrl').value.trim();
      if (!url) return;

      btnRun.disabled = true;
      btnRun.textContent = 'Testing Link...';

      try {
        const probe = await chrome.runtime.sendMessage({ type: 'INSPECT_LINK', url });
        lastInspectedUrl = url;

        document.getElementById('inspectorResults').classList.remove('hidden');
        document.getElementById('resResume').textContent = probe.supportsResume
          ? 'Supported (HTTP Range / 206)'
          : 'Single Stream Only';
        document.getElementById('resLength').textContent = probe.contentLength > 0 ? formatBytes(probe.contentLength) : 'Unknown';
        document.getElementById('resStatus').textContent = `HTTP ${probe.statusCode} ${probe.statusText || ''}`;
        document.getElementById('resFilename').textContent = probe.filename || '-';
        document.getElementById('resMime').textContent = probe.contentType || '-';
        document.getElementById('resEtag').textContent = probe.etag || 'None';

        const summaryText = probe.error
          ? `Problem with this link: ${probe.error}`
          : probe.supportsResume
            ? 'This link supports byte ranges, so it downloads over parallel connections and can be paused, resumed, or given a fresh URL if it expires.'
            : 'This server does not support byte ranges. It downloads as a single stream, and pausing restarts it from the beginning.';
        document.getElementById('resSummaryText').textContent = summaryText;
      } catch (err) {
        alert('Inspection failed: ' + err.message);
      } finally {
        btnRun.disabled = false;
        btnRun.textContent = 'Inspect Link';
      }
    });
  }

  const btnStartFromInsp = document.getElementById('btnStartFromInspector');
  if (btnStartFromInsp) {
    btnStartFromInsp.addEventListener('click', async () => {
      if (!lastInspectedUrl) return;
      try {
        const res = await chrome.runtime.sendMessage({
          type: 'CREATE_TASK',
          url: lastInspectedUrl,
          autoStart: true
        });
        if (res && res.error) throw new Error(res.error);
        document.querySelector('[data-tab="downloads"]').click();
      } catch (err) {
        alert('Failed: ' + err.message);
      }
    });
  }
}

// ------------------------------------------------------------------ settings

const SETTINGS_DEFAULTS = { captureEnabled: true, minSizeMB: 1, excludedDomains: [], connections: 4, chunkSizeMB: 4 };

async function loadSettings() {
  const { rdm_settings } = await chrome.storage.local.get('rdm_settings');
  const s = { ...SETTINGS_DEFAULTS, ...(rdm_settings || {}) };
  document.getElementById('setCaptureEnabled').checked = s.captureEnabled;
  document.getElementById('setMinSize').value = s.minSizeMB;
  document.getElementById('setConnections').value = String(s.connections);
  document.getElementById('setChunkSize').value = String(s.chunkSizeMB);
  document.getElementById('setExcluded').value = s.excludedDomains.join('\n');
}

async function saveSettings() {
  const minSize = parseFloat(document.getElementById('setMinSize').value);
  const excluded = document.getElementById('setExcluded').value
    .split(/[\n,]+/)
    .map(d => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
    .filter(Boolean);
  const { rdm_settings = {} } = await chrome.storage.local.get('rdm_settings');
  await chrome.storage.local.set({
    rdm_settings: {
      ...rdm_settings,
      captureEnabled: document.getElementById('setCaptureEnabled').checked,
      minSizeMB: Number.isFinite(minSize) && minSize >= 0 ? minSize : SETTINGS_DEFAULTS.minSizeMB,
      connections: parseInt(document.getElementById('setConnections').value, 10) || 4,
      chunkSizeMB: parseInt(document.getElementById('setChunkSize').value, 10) || 4,
      excludedDomains: [...new Set(excluded)]
    }
  });
  await loadSettings();
  const saved = document.getElementById('settingsSaved');
  saved.classList.remove('hidden');
  setTimeout(() => saved.classList.add('hidden'), 2000);
}

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnSaveSettings')?.addEventListener('click', saveSettings);
});

chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.rdm_tasks) {
    customTasks = changes.rdm_tasks.newValue || [];
    render();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message?.type === 'string' && message.type.startsWith('NATIVE_')) {
    loadData();
  }
});

setInterval(() => {
  loadData();
}, 1000);

document.addEventListener('DOMContentLoaded', () => {
  setupEvents();
  loadData();
});
