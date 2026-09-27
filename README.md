# 🛡️ Resilient Download Manager & Resume Fixer

A modern Chrome & Chromium browser extension designed to prevent broken downloads, enable robust pause & resume, and allow seamless **Link Refreshing** when temporary session tokens or file hosting links expire while paused.

---

## 🎯 Why Normal Browser Downloads Break on Pause & Resume

1. **Temporary / Expired Link Tokens**: File hosts (Google Drive, Dropbox, Mega, rapidshare-like hosts, AWS S3 signed URLs) issue links valid for only 15–60 minutes. If you pause a download and resume after the token expires, standard browsers attempt to fetch the expired URL, get `HTTP 401/403/410/404`, and permanently destroy your download progress.
2. **Missing Byte-Range (`Accept-Ranges`) Support**: If a server doesn't support partial content (`HTTP 206`), pausing a download in standard browsers silently restarts it from 0% or errors out.
3. **Flaky Connections**: Momentary network packet drops cause standard downloads to fail with "Network Error" rather than automatically retrying.

---

## ✨ Key Features

- 🔄 **Expired Link Refresher (IDM-like)**: If a download link expires, click **"Fix Link"**, paste a newly generated URL for the file, and continue from where it stopped. The new link is checked first: if it's a different file (different size) or can't resume, it's rejected rather than corrupting your download.
- 🎯 **Automatic capture (IDM-style)**: downloads you start normally in the browser are taken over automatically when the server supports resuming. Anything it can't improve on is left to the browser untouched: form (POST) downloads, one-time links, files under the minimum size (default 1 MB), servers without resume support, incognito windows, and sites on your exclusion list. Switch it with the **Capture on/off** pill in the popup, and fine-tune it in **Dashboard → Settings**. The page's Referer is sent along, so hosts that check it still work.
- ⚡ **Parallel connections**: 1–8 simultaneous connections per download (default 4), like IDM/FDM.
- 🧩 **Resilient Chunked Engine**: HTTP Range requests with exponential-backoff retries (5 per chunk), stalled-connection detection, and verification that every chunk is exactly the byte range requested.
- 💾 **Crash recovery**: finished chunks are stored in IndexedDB (on disk). If the browser closes or crashes mid-download, it picks up automatically on the next start.
- 🍪 Requests carry your site cookies, so links that need you to be logged in work.
- 🔬 **Pre-Flight Link Health Inspector**: Probe any URL before downloading to verify `Accept-Ranges: bytes` support, total content length, HTTP status, and ETag validity.
- 📊 **Real-Time Chunk Visualizer**: View an interactive block map showing downloaded chunks (green), active chunks (pulsing cyan), and pending chunks (dark slate).
- 🎛️ **Dual-Engine Architecture**: Monitors and controls both Chrome native downloads and Resilient Chunked downloads from one unified popup and dashboard.
- 🖱️ **Context Menu Integration**: Right-click any link on the web to "Download with Resilient Downloader" or "Check Resume Support".

---

## 🚀 How to Install in Your Browser (Chrome / Edge / Brave / Opera)

1. Open your browser and navigate to:
   - **Chrome**: `chrome://extensions/`
   - **Brave**: `brave://extensions/`
   - **Edge**: `edge://extensions/`
2. Enable **Developer Mode** (toggle in the top right corner).
3. Click the **"Load unpacked"** button in the top left.
4. Select the project folder:
   ```
   C:\Users\rosha\.gemini\antigravity\scratch\resilient-download-manager
   ```
5. Pin the extension to your toolbar for quick access!

---

## 📖 How to Use

### 1. Adding a Resilient Download
- Click the extension icon in your browser toolbar.
- Click the **`+`** button (or "Inspect" to verify link resumability).
- Paste your download URL and click **"Start Download"**.
- Alternatively, right-click any download link on any website and select **"Download with Resilient Downloader"**.

### 2. Pausing and Resuming
- Click **"Pause"** anytime on an active download. All downloaded chunks remain safely cached.
- Click **"Resume"** to continue right where you left off.

### 3. Refreshing an Expired Download Link
If a download fails or link expires while paused (common with file hosts):
1. Go back to the website and click download to generate a fresh link.
2. In the Resilient Download Manager, click **"Fix Link"** or **"Refresh Link"** on the paused item.
3. Paste the fresh URL and click **"Update & Resume"**.
4. The extension verifies that the file size matches and resumes downloading remaining chunks without restarting!

### 4. Opening the Full Dashboard
- Click the dashboard icon in the top right of the popup, or open extension options to view the full manager with the Chunk Visualizer and Link Inspector.

---

## 🧱 How it works

- `background.js`: service worker. It routes messages, owns the task list (`chrome.storage.local`, single writer), saves finished files with `chrome.downloads`, and restarts the engine after a crash.
- `offscreen.js`: the download engine. It runs in an offscreen document so downloads keep going when the service worker sleeps. It only has `chrome.runtime`, so it asks the background to store tasks and save files.
- `db.js`: task storage (serialized writes) plus chunk storage in IndexedDB.
- `popup.*` / `dashboard.*`: the UI.

## ⚠️ Limitations

- Servers without byte-range support download as a single stream: pausing restarts them from zero.
- The finished file is assembled in the browser before saving, so very large files (several GB) need matching free disk space for the temporary chunks.
- Links that check the `Referer` header, or need headers other than cookies, may refuse the download.
