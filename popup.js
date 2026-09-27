// Popup Controller for Resilient Download Manager

let currentFilter = 'all';
let customTasks = [];
let nativeTasks = [];

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

function getFileExtension(filename) {
  if (!filename) return 'FILE';
  const ext = filename.split('.').pop();
  return (ext && ext.length <= 4) ? ext.toUpperCase() : 'FILE';
}

async function loadDownloads() {
  try {
    const [cTasks, nTasks] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'GET_ALL_CUSTOM_TASKS' }),
      chrome.runtime.sendMessage({ type: 'GET_NATIVE_DOWNLOADS' })
    ]);

    customTasks = Array.isArray(cTasks) ? cTasks : [];
    nativeTasks = Array.isArray(nTasks) ? nTasks : [];
    render();
  } catch (err) {
    console.error('Failed to load downloads:', err);
  }
}

function updateStats(allList) {
  let active = 0;
  let paused = 0;
  let totalSpeed = 0;

  for (const item of allList) {
    if (item.status === 'downloading' || (item.state === 'in_progress' && !item.paused)) {
      active++;
      totalSpeed += (item.speed || item.bytesReceivedSpeed || 0);
    } else if (item.status === 'paused' || item.status === 'link_expired' || (item.state === 'in_progress' && item.paused)) {
      paused++;
    }
  }

  const activeCountEl = document.getElementById('activeCount');
  const pausedCountEl = document.getElementById('pausedCount');
  const totalSpeedEl = document.getElementById('totalSpeed');

  if (activeCountEl) activeCountEl.textContent = active;
  if (pausedCountEl) pausedCountEl.textContent = paused;
  if (totalSpeedEl) totalSpeedEl.textContent = formatSpeed(totalSpeed);
}

function render() {
  const listEl = document.getElementById('downloadList');
  const emptyState = document.getElementById('emptyState');
  if (!listEl) return;

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
    completedChunks: t.completedChunks ? t.completedChunks.length : 0,
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

  const combined = [...customNormalized, ...nativeNormalized].sort((a, b) => b.updatedAt - a.updatedAt);
  updateStats(combined);

  const filtered = combined.filter(item => {
    if (currentFilter === 'all') return true;
    if (currentFilter === 'downloading') return item.status === 'downloading';
    if (currentFilter === 'paused') return item.status === 'paused' || item.status === 'link_expired';
    if (currentFilter === 'completed') return item.status === 'completed';
    return true;
  });

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    if (emptyState) {
      listEl.appendChild(emptyState);
      emptyState.classList.remove('hidden');
    }
    return;
  }
  if (emptyState) emptyState.classList.add('hidden');

  for (const item of filtered) {
    listEl.appendChild(createCardElement(item));
  }
}

function createCardElement(item) {
  const card = document.createElement('div');
  const isExpired = item.status === 'link_expired';
  const isError = item.status === 'error';

  card.className = `download-card ${isExpired ? 'status-expired' : ''} ${isError ? 'status-error' : ''}`;

  const ext = getFileExtension(item.filename);
  const percent = (item.totalBytes > 0)
    ? Math.min(100, Math.max(0, ((item.downloadedBytes / item.totalBytes) * 100))).toFixed(1)
    : (item.status === 'completed' ? 100 : 0);

  let statusBadgeClass = item.supportsResume ? 'tag-resumable' : 'tag-non-resumable';
  let statusBadgeText = item.supportsResume ? 'Resumable' : 'Stream';

  let fillClass = '';
  if (item.status === 'paused') fillClass = 'paused';
  else if (item.status === 'completed') fillClass = 'completed';
  else if (item.status === 'error' || item.status === 'link_expired') fillClass = 'error';

  let actionsHtml = '';

  if (item.isCustom) {
    if (item.status === 'downloading') {
      actionsHtml += `<button class="btn-action btn-pause" data-action="custom-pause" data-id="${item.id}">Pause</button>`;
    } else if (item.status === 'paused') {
      actionsHtml += `<button class="btn-action btn-resume" data-action="custom-resume" data-id="${item.id}">Resume</button>`;
      actionsHtml += `<button class="btn-action btn-refresh" data-action="refresh-link" data-id="${item.id}">Refresh Link</button>`;
    } else if (item.status === 'link_expired' || item.status === 'error') {
      actionsHtml += `<button class="btn-action btn-refresh" data-action="refresh-link" data-id="${item.id}">Fix Link</button>`;
      actionsHtml += `<button class="btn-action btn-resume" data-action="custom-resume" data-id="${item.id}">Retry</button>`;
    } else if (item.status === 'queued') {
      actionsHtml += `<button class="btn-action btn-resume" data-action="custom-resume" data-id="${item.id}">Start</button>`;
    } else if (item.status === 'completed' && item.downloadId) {
      actionsHtml += `<button class="btn-action" data-action="native-open" data-id="${item.downloadId}">Open</button>`;
      actionsHtml += `<button class="btn-action" data-action="native-show" data-id="${item.downloadId}">Show</button>`;
    }
    actionsHtml += `<button class="btn-action btn-delete" data-action="custom-cancel" data-id="${item.id}" title="${item.status === 'completed' ? 'Remove from list (keeps the file)' : 'Cancel and delete'}">✕</button>`;
  } else {
    if (item.status === 'downloading') {
      actionsHtml += `<button class="btn-action btn-pause" data-action="native-pause" data-id="${item.id}">Pause</button>`;
    } else if (item.status === 'paused') {
      actionsHtml += `<button class="btn-action btn-resume" data-action="native-resume" data-id="${item.id}">Resume</button>`;
    } else if (item.status === 'error' && item.canResume) {
      actionsHtml += `<button class="btn-action btn-resume" data-action="native-resume" data-id="${item.id}">Retry</button>`;
    } else if (item.status === 'completed') {
      actionsHtml += `<button class="btn-action" data-action="native-open" data-id="${item.id}">Open</button>`;
      actionsHtml += `<button class="btn-action" data-action="native-show" data-id="${item.id}">Show</button>`;
    }
    const finished = item.status === 'completed' || item.status === 'error';
    actionsHtml += `<button class="btn-action btn-delete" data-action="${finished ? 'native-erase' : 'native-cancel'}" data-id="${item.id}" title="${finished ? 'Remove from list (keeps the file)' : 'Cancel'}">✕</button>`;
  }

  card.innerHTML = `
    <div class="card-top">
      <div class="file-info">
        <span class="file-badge">${ext}</span>
        <span class="file-name" title="${escapeHtml(item.filename)}">${escapeHtml(item.filename)}</span>
      </div>
      <div class="card-tags">
        <span class="tag tag-engine">${item.isCustom ? 'Resilient' : 'Native'}</span>
        <span class="tag ${statusBadgeClass}">${statusBadgeText}</span>
      </div>
    </div>

    ${isExpired ? `
      <div class="expired-banner">
        <span>⚠️ Download link expired while paused</span>
        <button class="btn-action btn-refresh text-sm" data-action="refresh-link" data-id="${item.id}">Fix Link</button>
      </div>
    ` : ''}

    <div class="progress-container">
      <div class="progress-fill ${fillClass}" style="width: ${percent}%;"></div>
    </div>

    <div class="card-stats">
      <span>${formatBytes(item.downloadedBytes)} / ${item.totalBytes > 0 ? formatBytes(item.totalBytes) : 'Unknown'} (${percent}%)</span>
      <div class="speed-eta">
        ${item.status === 'downloading' ? `<span>${formatSpeed(item.speed)}</span><span>ETA: ${formatEta(item.eta)}</span>` : ''}
        ${item.status === 'paused' ? '<span>Paused</span>' : ''}
        ${item.status === 'assembling' ? '<span>Saving file…</span>' : ''}
        ${item.status === 'queued' ? '<span>Queued</span>' : ''}
        ${item.status === 'completed' ? '<span style="color: var(--accent-green)">Completed</span>' : ''}
      </div>
    </div>

    ${item.errorMessage && !isExpired ? `<div class="error-text">${escapeHtml(item.errorMessage)}</div>` : ''}

    <div class="card-actions">
      ${actionsHtml}
    </div>
  `;

  card.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const action = btn.getAttribute('data-action');
      const id = btn.getAttribute('data-id');
      await handleAction(action, id);
    });
  });

  return card;
}

async function handleAction(action, id) {
  try {
    switch (action) {
      case 'custom-pause':
        await chrome.runtime.sendMessage({ type: 'PAUSE_TASK', taskId: id });
        break;
      case 'custom-resume':
        await chrome.runtime.sendMessage({ type: 'START_TASK', taskId: id });
        break;
      case 'custom-cancel':
        await chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId: id });
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
    await loadDownloads();
  } catch (err) {
    console.error(`Action ${action} failed:`, err);
  }
}

function setupUI() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentFilter = btn.getAttribute('data-filter');
      render();
    });
  });

  document.getElementById('btnOpenDashboard').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Auto-capture on/off (full settings live in the dashboard)
  const captureBtn = document.getElementById('btnCaptureToggle');
  const renderCapture = (on) => {
    captureBtn.classList.toggle('on', on);
    document.getElementById('captureLabel').textContent = on ? 'Capture on' : 'Capture off';
  };
  chrome.storage.local.get('rdm_settings').then(({ rdm_settings }) => renderCapture(rdm_settings?.captureEnabled !== false));
  captureBtn.addEventListener('click', async () => {
    const { rdm_settings = {} } = await chrome.storage.local.get('rdm_settings');
    const on = rdm_settings.captureEnabled === false;
    await chrome.storage.local.set({ rdm_settings: { ...rdm_settings, captureEnabled: on } });
    renderCapture(on);
  });

  const addModal = document.getElementById('addModal');
  const btnOpenAddModal = document.getElementById('btnOpenAddModal');
  const btnEmptyAdd = document.getElementById('btnEmptyAdd');
  const btnCloseAddModal = document.getElementById('btnCloseAddModal');
  const btnCancelAdd = document.getElementById('btnCancelAdd');
  const btnInspect = document.getElementById('btnInspect');
  const btnStartDownload = document.getElementById('btnStartDownload');

  const openAdd = () => {
    addModal.classList.remove('hidden');
    document.getElementById('inputUrl').focus();
    navigator.clipboard.readText().then(text => {
      if (text && (text.startsWith('http://') || text.startsWith('https://'))) {
        document.getElementById('inputUrl').value = text;
        inspectUrl(text);
      }
    }).catch(() => {});
  };

  const closeAdd = () => {
    addModal.classList.add('hidden');
    document.getElementById('probeResult').classList.add('hidden');
    document.getElementById('inputUrl').value = '';
    document.getElementById('inputFilename').value = '';
  };

  if (btnOpenAddModal) btnOpenAddModal.addEventListener('click', openAdd);
  if (btnEmptyAdd) btnEmptyAdd.addEventListener('click', openAdd);
  if (btnCloseAddModal) btnCloseAddModal.addEventListener('click', closeAdd);
  if (btnCancelAdd) btnCancelAdd.addEventListener('click', closeAdd);

  if (btnInspect) {
    btnInspect.addEventListener('click', () => {
      const url = document.getElementById('inputUrl').value.trim();
      if (url) inspectUrl(url);
    });
  }

  if (btnStartDownload) {
    btnStartDownload.addEventListener('click', async () => {
      const url = document.getElementById('inputUrl').value.trim();
      const filename = document.getElementById('inputFilename').value.trim() || null;
      const chunkSizeMB = parseInt(document.getElementById('selectChunkSize').value, 10) || 4;
      const connections = parseInt(document.getElementById('selectConnections').value, 10) || 4;

      if (!url) {
        alert('Please enter a valid URL');
        return;
      }

      try {
        btnStartDownload.disabled = true;
        btnStartDownload.textContent = 'Starting...';

        const res = await chrome.runtime.sendMessage({
          type: 'CREATE_TASK',
          url,
          filename,
          chunkSizeMB,
          connections,
          autoStart: true
        });

        if (res && res.error) {
          throw new Error(res.error);
        }

        closeAdd();
        await loadDownloads();
      } catch (err) {
        alert('Failed to start download: ' + err.message);
      } finally {
        btnStartDownload.disabled = false;
        btnStartDownload.textContent = 'Start Download';
      }
    });
  }

  // Refresh Link Modal
  const refreshModal = document.getElementById('refreshModal');
  const btnCloseRefreshModal = document.getElementById('btnCloseRefreshModal');
  const btnCancelRefresh = document.getElementById('btnCancelRefresh');
  const btnConfirmRefresh = document.getElementById('btnConfirmRefresh');

  if (btnCloseRefreshModal) btnCloseRefreshModal.addEventListener('click', () => refreshModal.classList.add('hidden'));
  if (btnCancelRefresh) btnCancelRefresh.addEventListener('click', () => refreshModal.classList.add('hidden'));

  if (btnConfirmRefresh) {
    btnConfirmRefresh.addEventListener('click', async () => {
      const taskId = document.getElementById('refreshTaskId').value;
      const newUrl = document.getElementById('inputNewUrl').value.trim();
      const errorEl = document.getElementById('refreshError');

      if (!newUrl) {
        errorEl.textContent = 'Please enter a valid URL';
        errorEl.classList.remove('hidden');
        return;
      }

      try {
        btnConfirmRefresh.disabled = true;
        btnConfirmRefresh.textContent = 'Updating...';
        errorEl.classList.add('hidden');

        const res = await chrome.runtime.sendMessage({
          type: 'UPDATE_TASK_URL',
          taskId,
          newUrl
        });

        if (res && res.error) {
          throw new Error(res.error);
        }

        await chrome.runtime.sendMessage({ type: 'START_TASK', taskId });
        refreshModal.classList.add('hidden');
        await loadDownloads();
      } catch (err) {
        errorEl.textContent = err.message || 'Failed to update link';
        errorEl.classList.remove('hidden');
      } finally {
        btnConfirmRefresh.disabled = false;
        btnConfirmRefresh.textContent = 'Update & Resume';
      }
    });
  }
}

async function inspectUrl(url) {
  const probeCard = document.getElementById('probeResult');
  const probeFilename = document.getElementById('probeFilename');
  const probeSize = document.getElementById('probeSize');
  const probeResume = document.getElementById('probeResume');
  const btnInspect = document.getElementById('btnInspect');

  if (!probeCard || !btnInspect) return;

  btnInspect.disabled = true;
  btnInspect.textContent = 'Checking...';

  try {
    const probe = await chrome.runtime.sendMessage({ type: 'INSPECT_LINK', url });
    probeCard.classList.remove('hidden');

    probeFilename.textContent = probe.filename || 'Unknown';
    probeSize.textContent = probe.contentLength > 0 ? formatBytes(probe.contentLength) : 'Unknown (Streaming)';

    if (probe.error) {
      probeResume.textContent = probe.error;
      probeResume.className = 'probe-status not-resumable';
    } else if (probe.supportsResume) {
      probeResume.textContent = 'Supported (HTTP Range)';
      probeResume.className = 'probe-status resumable';
    } else {
      probeResume.textContent = 'Single Stream Only';
      probeResume.className = 'probe-status not-resumable';
    }

    const inputFilename = document.getElementById('inputFilename');
    if (inputFilename && !inputFilename.value && probe.filename) {
      inputFilename.placeholder = probe.filename;
    }
  } catch (err) {
    console.error('Probe error:', err);
  } finally {
    btnInspect.disabled = false;
    btnInspect.textContent = 'Inspect';
  }
}

function openRefreshModal(taskId) {
  const task = customTasks.find(t => t.id === taskId);
  if (!task) return;

  const refreshModal = document.getElementById('refreshModal');
  document.getElementById('refreshTaskId').value = taskId;
  document.getElementById('refreshTaskName').textContent = task.filename;
  document.getElementById('refreshTaskProgress').textContent =
    `Progress: ${formatBytes(task.downloadedBytes)} / ${formatBytes(task.totalBytes)} (${((task.downloadedBytes / (task.totalBytes || 1)) * 100).toFixed(1)}%)`;
  document.getElementById('inputNewUrl').value = '';
  document.getElementById('refreshError').classList.add('hidden');

  refreshModal.classList.remove('hidden');
  document.getElementById('inputNewUrl').focus();
}

// Storage change listener: guarantees instant update across popup/background
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'local' && changes.rdm_tasks) {
    customTasks = changes.rdm_tasks.newValue || [];
    render();
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (typeof message?.type === 'string' && message.type.startsWith('NATIVE_')) {
    loadDownloads();
  }
});

setInterval(() => {
  loadDownloads();
}, 1000);

document.addEventListener('DOMContentLoaded', () => {
  setupUI();
  loadDownloads();
});
