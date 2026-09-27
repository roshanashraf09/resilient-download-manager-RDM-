// Offscreen download engine.
// Runs in an offscreen document so downloads survive the service worker going to sleep.
// Offscreen documents only get chrome.runtime, so storage writes and the final
// "save to disk" step are sent to the background worker.
import { db } from './db.js';

const DEFAULT_CONNECTIONS = 4;
const MAX_RETRIES = 5;
const CHUNK_TIMEOUT_MS = 60000;       // abort a connection that stalls this long
const PROGRESS_SAVE_MS = 700;         // throttle progress writes to storage

function sanitizeFilename(name) {
  const clean = (name || '')
    .replace(/[\u0000-\u001f<>:"/\\|?*]+/g, '_')
    .replace(/^[\s.]+|[\s.]+$/g, '')
    .slice(0, 180);
  return clean || 'download.bin';
}

function parseFilename(disposition, url) {
  if (disposition) {
    const star = disposition.match(/filename\*\s*=\s*(?:[\w-]+)?'[^']*'([^;]+)/i);
    if (star) {
      try { return sanitizeFilename(decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''))); } catch (e) {}
    }
    const plain = disposition.match(/filename\s*=\s*"([^"]+)"|filename\s*=\s*([^;]+)/i);
    if (plain) {
      const raw = (plain[1] || plain[2]).trim();
      try { return sanitizeFilename(decodeURIComponent(raw)); } catch (e) { return sanitizeFilename(raw); }
    }
  }
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last && last.includes('.')) return sanitizeFilename(decodeURIComponent(last));
  } catch (e) {}
  return 'download_' + Math.floor(Date.now() / 1000);
}

class LinkExpiredError extends Error {}
class FatalError extends Error {}   // retrying won't help (e.g. server ignores ranges)

class OffscreenDownloader {
  constructor() {
    this.activeTasks = new Map();
  }

  // Save task state (throttled for progress updates unless force=true)
  async persist(task, force = false) {
    const info = this.activeTasks.get(task.id);
    const now = Date.now();
    if (!force && info && now - (info.lastPersist || 0) < PROGRESS_SAVE_MS) return;
    if (info) info.lastPersist = now;
    task.updatedAt = now;
    await db.saveTask(task);
  }

  // ------------------------------------------------------------------ inspection

  async inspectLink(url) {
    const result = {
      url, valid: false, supportsResume: false, contentLength: 0,
      contentType: 'application/octet-stream', filename: parseFilename(null, url),
      etag: null, lastModified: null, statusCode: 0, statusText: '', finalUrl: url, error: null
    };
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 10000);
    try {
      // A 1-byte range GET is the most reliable probe: many servers answer HEAD wrongly
      let res = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'include', signal: ctrl.signal })
        .catch(() => null);
      if (!res || !(res.ok || res.status === 206)) {
        const head = await fetch(url, { method: 'HEAD', credentials: 'include', signal: ctrl.signal }).catch(() => null);
        if (head) res = head;
      }
      if (!res) throw new Error('Could not reach the server');

      result.statusCode = res.status;
      result.statusText = res.statusText;
      result.valid = res.ok || res.status === 206;
      result.finalUrl = res.url || url;
      const contentRange = res.headers.get('content-range');
      const contentLength = res.headers.get('content-length');
      result.etag = res.headers.get('etag');
      result.lastModified = res.headers.get('last-modified');
      result.contentType = (res.headers.get('content-type') || result.contentType).split(';')[0];
      result.filename = parseFilename(res.headers.get('content-disposition'), result.finalUrl);

      // Only a real 206 with a Content-Range proves byte ranges work
      if (res.status === 206 && contentRange) {
        const m = contentRange.match(/\/(\d+)\s*$/);
        if (m) {
          result.contentLength = parseInt(m[1], 10);
          result.supportsResume = true;
        }
      } else if (contentLength) {
        result.contentLength = parseInt(contentLength, 10);
        result.supportsResume = res.headers.get('accept-ranges') === 'bytes' && res.status !== 200;
      }
      if (res.body) res.body.cancel().catch(() => {});
      if (!result.valid) result.error = `Server returned HTTP ${res.status}`;
    } catch (err) {
      result.error = err.name === 'AbortError' ? 'Server did not respond within 10s' : err.message;
    } finally {
      clearTimeout(tid);
    }
    return result;
  }

  // ------------------------------------------------------------------ task lifecycle

  async createTask(url, customFilename = null, chunkSizeMB = 4, connections = DEFAULT_CONNECTIONS, referrer = null) {
    const probe = await this.inspectLink(url);
    if (!probe.valid) {
      throw new Error(`Link check failed: ${probe.error || 'HTTP ' + probe.statusCode}`);
    }
    const chunkSize = Math.max(1, chunkSizeMB) * 1024 * 1024;
    const chunked = probe.supportsResume && probe.contentLength > 0;
    const task = {
      id: 'rdm_' + Date.now() + '_' + Math.random().toString(36).substring(2, 7),
      url,
      originalUrl: url,
      referrer,
      filename: sanitizeFilename(customFilename || probe.filename),
      contentType: probe.contentType,
      totalBytes: probe.contentLength || 0,
      downloadedBytes: 0,
      chunkSize,
      totalChunks: chunked ? Math.ceil(probe.contentLength / chunkSize) : 1,
      completedChunks: [],
      connections: Math.min(16, Math.max(1, connections || DEFAULT_CONNECTIONS)),
      supportsResume: chunked,
      etag: probe.etag,
      lastModified: probe.lastModified,
      status: 'queued',
      errorMessage: null,
      speed: 0,
      eta: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      completedAt: null,
      downloadId: null
    };
    await db.saveTask(task);
    return task;
  }

  async startTask(taskId) {
    if (this.activeTasks.has(taskId)) return;
    const task = await db.getTask(taskId);
    if (!task) throw new Error('Task not found: ' + taskId);
    if (task.status === 'completed') return;

    const info = { controller: new AbortController(), task, lastPersist: 0, inflight: new Map() };
    this.activeTasks.set(taskId, info);

    task.status = 'downloading';
    task.errorMessage = null;
    await this.persist(task, true);

    this._run(task, info)
      .catch(async (err) => {
        if (info.userAborted) return; // paused or cancelled by the user
        console.error(`Task ${taskId} failed:`, err);
        task.status = err instanceof LinkExpiredError ? 'link_expired' : 'error';
        task.errorMessage = err.message || 'Download interrupted';
        task.speed = 0;
        task.eta = 0;
        await this.persist(task, true);
      })
      .finally(() => {
        if (this.activeTasks.get(taskId) === info) this.activeTasks.delete(taskId);
      });
  }

  async _run(task, info) {
    if (task.supportsResume && task.totalBytes > 0) {
      await this._downloadChunks(task, info);
    } else {
      await this._downloadStream(task, info);
    }
  }

  // ------------------------------------------------------------------ chunked (parallel) download

  async _downloadChunks(task, info) {
    const { controller } = info;
    const { chunkSize, totalBytes, totalChunks } = task;
    const chunkBounds = (i) => [i * chunkSize, Math.min((i + 1) * chunkSize, totalBytes) - 1];

    // Trust what is actually on disk over the saved list (e.g. after a crash mid-write)
    const stored = new Set(await db.getStoredChunkIndexes(task.id));
    const completed = new Set((task.completedChunks || []).filter(i => stored.has(i)));
    for (const i of stored) if (i < totalChunks) completed.add(i);

    const completedBytes = () => [...completed].reduce((sum, i) => {
      const [s, e] = chunkBounds(i);
      return sum + (e - s + 1);
    }, 0);
    const updateProgress = () => {
      let inflight = 0;
      for (const b of info.inflight.values()) inflight += b;
      task.completedChunks = [...completed].sort((a, b) => a - b);
      task.downloadedBytes = Math.min(totalBytes, completedBytes() + inflight);
    };

    // Speed / ETA sampling
    let lastBytes = completedBytes();
    let lastTime = Date.now();
    const speedTimer = setInterval(() => {
      updateProgress();
      const now = Date.now();
      const instant = Math.max(0, (task.downloadedBytes - lastBytes) / ((now - lastTime) / 1000));
      task.speed = task.speed ? task.speed * 0.6 + instant * 0.4 : instant; // smoothed
      task.eta = task.speed > 0 ? Math.ceil((totalBytes - task.downloadedBytes) / task.speed) : 0;
      lastBytes = task.downloadedBytes;
      lastTime = now;
      this.persist(task);
    }, 1000);

    const pending = [];
    for (let i = 0; i < totalChunks; i++) if (!completed.has(i)) pending.push(i);

    const worker = async () => {
      while (pending.length && !controller.signal.aborted) {
        const index = pending.shift();
        const [start, end] = chunkBounds(index);
        const blob = await this._fetchChunkWithRetry(task, index, start, end, info);
        if (controller.signal.aborted) return;
        await db.saveChunk(task.id, index, blob);
        info.inflight.delete(index);
        completed.add(index);
        updateProgress();
        await this.persist(task, true);
      }
    };

    try {
      const workers = Array.from({ length: Math.min(task.connections || DEFAULT_CONNECTIONS, pending.length || 1) }, worker);
      // If one connection hits a fatal error, stop the others too
      await Promise.all(workers.map(w => w.catch(err => {
        if (!controller.signal.aborted) controller.abort(err);
        throw err;
      })));
    } catch (err) {
      clearInterval(speedTimer);
      const reason = controller.signal.reason;
      if (reason instanceof Error) throw reason;  // fatal error from a worker
      throw err;
    } finally {
      clearInterval(speedTimer);
    }

    if (controller.signal.aborted) return;
    if (completed.size === totalChunks) {
      await this._finalizeChunks(task);
    }
  }

  async _fetchChunkWithRetry(task, index, start, end, info) {
    const { controller } = info;
    const expected = end - start + 1;
    let lastError;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      if (controller.signal.aborted) throw new Error('Paused');
      info.inflight.set(index, 0);

      const attemptCtrl = new AbortController();
      const onAbort = () => attemptCtrl.abort();
      controller.signal.addEventListener('abort', onAbort);
      let stallTimer = setTimeout(() => attemptCtrl.abort(), CHUNK_TIMEOUT_MS);
      const resetStall = () => {
        clearTimeout(stallTimer);
        stallTimer = setTimeout(() => attemptCtrl.abort(), CHUNK_TIMEOUT_MS);
      };

      try {
        const res = await fetch(task.url, {
          headers: { Range: `bytes=${start}-${end}` },
          credentials: 'include',
          signal: attemptCtrl.signal
        });

        if ([401, 403, 404, 410].includes(res.status)) {
          throw new LinkExpiredError(`Download link expired or was revoked (HTTP ${res.status}). Use "Fix Link" to paste a fresh one.`);
        }
        if (res.status === 200) {
          // Server ignored the Range header and is sending the whole file: continuing would corrupt it
          res.body?.cancel().catch(() => {});
          throw new FatalError('The server stopped supporting resumable downloads for this link. Try "Fix Link" with a fresh URL.');
        }
        if (res.status !== 206) throw new Error(`Server returned HTTP ${res.status}`);

        const contentRange = res.headers.get('content-range') || '';
        const m = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
        if (m && parseInt(m[1], 10) !== start) {
          throw new FatalError(`Server sent the wrong byte range (${contentRange}); the file may have changed`);
        }
        if (m && m[3] !== '*' && parseInt(m[3], 10) !== task.totalBytes) {
          throw new FatalError(`File size on the server changed (${m[3]} vs ${task.totalBytes} bytes). The link now points to a different file.`);
        }

        // Stream the body so progress/speed update during the chunk, not just after it
        const reader = res.body.getReader();
        const parts = [];
        let received = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parts.push(value);
          received += value.byteLength;
          info.inflight.set(index, received);
          resetStall();
        }
        if (received !== expected) throw new Error(`Chunk ${index} incomplete (${received}/${expected} bytes)`);
        return new Blob(parts);
      } catch (err) {
        if (controller.signal.aborted) throw err;
        if (err instanceof LinkExpiredError || err instanceof FatalError) throw err;
        lastError = err.name === 'AbortError' ? new Error(`Connection stalled on chunk ${index}`) : err;
        info.inflight.set(index, 0);
        if (attempt < MAX_RETRIES) {
          await new Promise(r => setTimeout(r, Math.min(15000, 1000 * 2 ** (attempt - 1))));
        }
      } finally {
        clearTimeout(stallTimer);
        controller.signal.removeEventListener('abort', onAbort);
      }
    }
    throw lastError || new Error(`Chunk ${index} failed after ${MAX_RETRIES} attempts`);
  }

  // ------------------------------------------------------------------ single-stream download

  async _downloadStream(task, info) {
    const { controller } = info;
    // Without byte ranges a paused download has to restart from zero
    task.downloadedBytes = 0;
    const res = await fetch(task.url, { credentials: 'include', signal: controller.signal });
    if ([401, 403, 404, 410].includes(res.status)) {
      throw new LinkExpiredError(`Download link expired or was revoked (HTTP ${res.status})`);
    }
    if (!res.ok) throw new Error(`Server returned HTTP ${res.status}`);

    const len = parseInt(res.headers.get('content-length') || '0', 10);
    if (len > 0) task.totalBytes = len;

    const reader = res.body.getReader();
    const parts = [];
    let lastBytes = 0;
    let lastTime = Date.now();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      task.downloadedBytes += value.byteLength;
      const now = Date.now();
      if (now - lastTime >= 1000) {
        task.speed = (task.downloadedBytes - lastBytes) / ((now - lastTime) / 1000);
        task.eta = task.totalBytes && task.speed ? Math.ceil((task.totalBytes - task.downloadedBytes) / task.speed) : 0;
        lastBytes = task.downloadedBytes;
        lastTime = now;
      }
      this.persist(task);
    }
    if (controller.signal.aborted) return;
    if (task.totalBytes && task.downloadedBytes !== task.totalBytes) {
      throw new Error(`Connection closed early (${task.downloadedBytes}/${task.totalBytes} bytes)`);
    }
    await this._saveBlob(task, new Blob(parts, { type: task.contentType || 'application/octet-stream' }));
  }

  // ------------------------------------------------------------------ assembling & saving

  async _finalizeChunks(task) {
    task.status = 'assembling';
    task.speed = 0;
    task.eta = 0;
    await this.persist(task, true);
    const blobs = await db.getChunksForTask(task.id, task.totalChunks);
    const blob = new Blob(blobs, { type: task.contentType || 'application/octet-stream' });
    if (blob.size !== task.totalBytes) {
      throw new Error(`Assembled file is ${blob.size} bytes, expected ${task.totalBytes}`);
    }
    await this._saveBlob(task, blob);
  }

  async _saveBlob(task, blob) {
    const blobUrl = URL.createObjectURL(blob);
    const res = await chrome.runtime.sendMessage({
      target: 'background', type: 'SAVE_FILE', blobUrl, filename: task.filename, taskId: task.id
    });
    if (!res || res.error) {
      URL.revokeObjectURL(blobUrl);
      throw new Error('Could not save the file: ' + (res?.error || 'no response from background'));
    }
    // The blob URL must stay valid until Chrome has finished copying it to disk;
    // the background tells us when (RELEASE_BLOB).
    pendingBlobUrls.set(res.downloadId, { blobUrl, taskId: task.id });

    task.status = 'completed';
    task.completedAt = Date.now();
    task.downloadId = res.downloadId;
    task.downloadedBytes = blob.size;
    task.totalBytes = task.totalBytes || blob.size;
    task.speed = 0;
    task.eta = 0;
    await this.persist(task, true);
    // Chunks are deleted once Chrome confirms the file is on disk (RELEASE_BLOB)
  }

  // ------------------------------------------------------------------ controls

  async pauseTask(taskId) {
    const info = this.activeTasks.get(taskId);
    const task = info?.task || await db.getTask(taskId);
    if (info) {
      info.userAborted = true;
      info.controller.abort();
      this.activeTasks.delete(taskId);
    }
    if (task && task.status !== 'completed') {
      task.status = 'paused';
      task.speed = 0;
      task.eta = 0;
      if (info) {
        // Partially received chunks are discarded; show only what's safely stored
        info.inflight.clear();
        if (task.supportsResume) {
          const { chunkSize, totalBytes } = task;
          task.downloadedBytes = (task.completedChunks || []).reduce((sum, i) =>
            sum + Math.min(chunkSize, totalBytes - i * chunkSize), 0);
        }
      }
      await this.persist(task, true);
    }
  }

  async cancelTask(taskId) {
    const info = this.activeTasks.get(taskId);
    if (info) {
      info.userAborted = true;
      info.controller.abort();
      this.activeTasks.delete(taskId);
    }
    await db.deleteTask(taskId);
  }

  async updateTaskUrl(taskId, newUrl) {
    if (this.activeTasks.has(taskId)) await this.pauseTask(taskId);
    const task = await db.getTask(taskId);
    if (!task) throw new Error('Task not found');

    const probe = await this.inspectLink(newUrl);
    if (!probe.valid) throw new Error(`The new link doesn't work: ${probe.error || 'HTTP ' + probe.statusCode}`);
    if (task.supportsResume && task.completedChunks?.length) {
      if (!probe.supportsResume) {
        throw new Error('The new link does not support resuming, so the downloaded parts cannot be reused.');
      }
      if (task.totalBytes && probe.contentLength && probe.contentLength !== task.totalBytes) {
        throw new Error(`The new link is a different file (${probe.contentLength} bytes, expected ${task.totalBytes}).`);
      }
    }
    task.url = newUrl;
    task.status = 'paused';
    task.errorMessage = null;
    await this.persist(task, true);
    return task;
  }

  // After a browser restart or crash, pick up downloads that were running
  async resumeInterrupted() {
    const tasks = await db.getAllTasks();
    for (const t of tasks) {
      if (t.status === 'completed') {
        // Leftover chunks from a file that was saved before this document restarted
        db.deleteAllChunksForTask(t.id).catch(() => {});
      } else if (t.status === 'downloading' || t.status === 'assembling') {
        this.startTask(t.id).catch(err => console.error('Auto-resume failed:', err));
      }
    }
  }
}

const downloader = new OffscreenDownloader();
const pendingBlobUrls = new Map();

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.target !== 'offscreen') return;

  const handle = async () => {
    switch (request.type) {
      case 'INSPECT_LINK':
        return await downloader.inspectLink(request.url);
      case 'CREATE_TASK': {
        const task = await downloader.createTask(request.url, request.filename, request.chunkSizeMB, request.connections, request.referrer);
        if (request.autoStart !== false) await downloader.startTask(task.id);
        return task;
      }
      case 'START_TASK':
        await downloader.startTask(request.taskId);
        return { success: true };
      case 'PAUSE_TASK':
        await downloader.pauseTask(request.taskId);
        return { success: true };
      case 'CANCEL_TASK':
        await downloader.cancelTask(request.taskId);
        return { success: true };
      case 'UPDATE_TASK_URL':
        return await downloader.updateTaskUrl(request.taskId, request.newUrl);
      case 'RELEASE_BLOB': {
        const pending = pendingBlobUrls.get(request.downloadId);
        if (pending) {
          URL.revokeObjectURL(pending.blobUrl);
          pendingBlobUrls.delete(request.downloadId);
          if (request.ok) await db.deleteAllChunksForTask(pending.taskId);
        }
        return { success: true };
      }
      case 'ACTIVE_COUNT':
        return { active: downloader.activeTasks.size, pendingSaves: pendingBlobUrls.size };
      default:
        return { error: 'Unknown offscreen action: ' + request.type };
    }
  };

  handle().then(sendResponse).catch(err => sendResponse({ error: err.message }));
  return true;
});

downloader.resumeInterrupted();
