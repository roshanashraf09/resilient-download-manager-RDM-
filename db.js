// Storage layer
//
// Tasks: chrome.storage.local ('rdm_tasks' array). Only the background service worker writes it,
//        through a serialized queue, so concurrent updates can't overwrite each other.
//        The offscreen document has no chrome.storage API, so it sends its writes to the background.
// Chunks: IndexedDB (binary data, stored as Blobs so Chrome keeps them on disk, not in RAM).

const DB_NAME = 'ResilientDownloaderDB';
const DB_VERSION = 3;
const STORE_CHUNKS = 'chunks';

const hasStorageApi = () => typeof chrome !== 'undefined' && Boolean(chrome?.storage?.local);

class DownloadDB {
  constructor() {
    this.idb = null;
    this.initPromise = null;
    this.writeQueue = Promise.resolve();
    this.cache = new Map(); // offscreen-side copy of task state
    this.deletedIds = new Set(); // late progress writes must not bring a deleted task back
  }

  // ------------------------------------------------------------------ tasks

  async getAllTasks() {
    if (hasStorageApi()) {
      const data = await chrome.storage.local.get('rdm_tasks');
      return data.rdm_tasks || [];
    }
    const tasks = await chrome.runtime.sendMessage({ target: 'background_storage', action: 'getAll' });
    for (const t of tasks || []) {
      if (!this.cache.has(t.id)) this.cache.set(t.id, t);
    }
    return tasks || [];
  }

  async getTask(id) {
    if (!hasStorageApi() && this.cache.has(id)) return this.cache.get(id);
    const all = await this.getAllTasks();
    return all.find(t => t.id === id) || null;
  }

  _mutate(fn) {
    // Serialize read-modify-write cycles on rdm_tasks
    this.writeQueue = this.writeQueue.then(async () => {
      const data = await chrome.storage.local.get('rdm_tasks');
      const tasks = fn(data.rdm_tasks || []);
      await chrome.storage.local.set({ rdm_tasks: tasks });
    }).catch(err => console.error('rdm storage write failed:', err));
    return this.writeQueue;
  }

  async saveTask(task) {
    if (!task || !task.id) return task;
    if (!hasStorageApi()) {
      this.cache.set(task.id, task);
      await chrome.runtime.sendMessage({ target: 'background_storage', action: 'save', task }).catch(() => {});
      return task;
    }
    const snapshot = JSON.parse(JSON.stringify(task));
    await this._mutate(tasks => {
      const idx = tasks.findIndex(t => t.id === task.id);
      if (idx >= 0) {
        // Never resurrect a task that was deleted, and never let a stale progress
        // write overwrite a newer status change
        if ((tasks[idx].updatedAt || 0) > (snapshot.updatedAt || 0)) return tasks;
        tasks[idx] = snapshot;
      } else if (!this.deletedIds.has(snapshot.id)) {
        tasks.unshift(snapshot);
      }
      return tasks;
    });
    return task;
  }

  async deleteTask(id) {
    this.cache.delete(id);
    this.deletedIds.add(id);
    if (!hasStorageApi()) {
      await chrome.runtime.sendMessage({ target: 'background_storage', action: 'delete', id }).catch(() => {});
    } else {
      await this._mutate(tasks => tasks.filter(t => t.id !== id));
    }
    await this.deleteAllChunksForTask(id).catch(() => {});
  }

  // ------------------------------------------------------------------ chunks (IndexedDB)

  async init() {
    if (this.idb) return this.idb;
    if (this.initPromise) return this.initPromise;
    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const idb = request.result;
        // Old versions kept a duplicate task store here; tasks now live in chrome.storage only
        if (idb.objectStoreNames.contains('tasks')) idb.deleteObjectStore('tasks');
        if (!idb.objectStoreNames.contains(STORE_CHUNKS)) {
          idb.createObjectStore(STORE_CHUNKS, { keyPath: ['taskId', 'chunkIndex'] });
        }
      };
      request.onsuccess = () => { this.idb = request.result; resolve(this.idb); };
      request.onerror = () => reject(request.error);
    });
    return this.initPromise;
  }

  async _tx(mode, fn) {
    await this.init();
    return new Promise((resolve, reject) => {
      const tx = this.idb.transaction(STORE_CHUNKS, mode);
      let result;
      Promise.resolve(fn(tx.objectStore(STORE_CHUNKS))).then(r => { result = r; });
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  }

  saveChunk(taskId, chunkIndex, data) {
    const blob = data instanceof Blob ? data : new Blob([data]);
    return this._tx('readwrite', store => {
      store.put({ taskId, chunkIndex, data: blob, size: blob.size, savedAt: Date.now() });
    });
  }

  getChunk(taskId, chunkIndex) {
    return this._tx('readonly', store => new Promise((resolve, reject) => {
      const req = store.get([taskId, chunkIndex]);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  }

  // Indexes of chunks actually present on disk (used to reconcile after a crash)
  getStoredChunkIndexes(taskId) {
    const range = IDBKeyRange.bound([taskId, -Infinity], [taskId, Infinity]);
    return this._tx('readonly', store => new Promise((resolve, reject) => {
      const req = store.getAllKeys(range);
      req.onsuccess = () => resolve((req.result || []).map(k => k[1]));
      req.onerror = () => reject(req.error);
    }));
  }

  async getChunksForTask(taskId, totalChunks) {
    const blobs = [];
    for (let i = 0; i < totalChunks; i++) {
      const chunk = await this.getChunk(taskId, i);
      if (!chunk || !chunk.data) throw new Error(`Missing chunk #${i}. Resume the download to re-fetch it`);
      blobs.push(chunk.data instanceof Blob ? chunk.data : new Blob([chunk.data]));
    }
    return blobs;
  }

  deleteAllChunksForTask(taskId) {
    const range = IDBKeyRange.bound([taskId, -Infinity], [taskId, Infinity]);
    return this._tx('readwrite', store => { store.delete(range); });
  }
}

export const db = new DownloadDB();
