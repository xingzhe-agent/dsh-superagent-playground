'use strict';

const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, protocol, net, shell, systemPreferences, session } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const isE2E = process.argv.includes('--e2e');
const isE2E_REC = process.argv.includes('--e2e-rec');
const isSmoke = process.argv.includes('--smoke');

function dataRoot() {
  if (process.env.FOCUSEE_DATA_DIR) return process.env.FOCUSEE_DATA_DIR;
  const base = isE2E || isSmoke ? os.tmpdir() : app.getPath('userData');
  return path.join(base, isE2E || isSmoke ? 'focusee-clone-e2e' : 'focusee-clone');
}

const PROJECTS_DIR = () => path.join(dataRoot(), 'projects');
const SETTINGS_FILE = () => path.join(dataRoot(), 'settings.json');

async function ensureDirs() {
  await fsp.mkdir(PROJECTS_DIR(), { recursive: true });
}

async function readSettings() {
  try {
    return JSON.parse(await fsp.readFile(SETTINGS_FILE(), 'utf8'));
  } catch {
    return {};
  }
}

async function writeSettings(patch) {
  const cur = await readSettings();
  const next = { ...cur, ...patch };
  await fsp.writeFile(SETTINGS_FILE(), JSON.stringify(next, null, 2));
  return next;
}

function projectDir(id) {
  if (!/^[a-z0-9_-]{3,64}$/i.test(id)) throw new Error(`bad project id: ${id}`);
  return path.join(PROJECTS_DIR(), id);
}

async function loadProject(id) {
  const file = path.join(projectDir(id), 'project.json');
  const raw = await fsp.readFile(file, 'utf8');
  return JSON.parse(raw);
}

async function saveProject(project) {
  project.updatedAt = Date.now();
  const dir = projectDir(project.id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'project.json'), JSON.stringify(project, null, 2));
  return project;
}

async function listProjects() {
  await ensureDirs();
  const entries = await fsp.readdir(PROJECTS_DIR(), { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    try {
      const p = await loadProject(e.name);
      out.push({
        id: p.id,
        name: p.name,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        duration: p.duration,
        videoSize: p.videoSize,
        videoFile: p.videoFile,
        hasAudio: p.hasAudio,
        thumb: p.thumb || null,
        zoomCount: (p.zooms || []).length,
      });
    } catch {
      // ignore half-written projects
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

// ---------------------------------------------------------------------------
// Recording: cursor sampling (global, no special permission needed for position)
// ---------------------------------------------------------------------------

let cursorTimer = null;
let cursorSamples = [];
let cursorStartedAt = 0;

function startCursorSampling() {
  stopCursorSampling();
  cursorSamples = [];
  cursorStartedAt = Date.now();
  const sample = () => {
    const p = screen.getCursorScreenPoint();
    cursorSamples.push({ t: (Date.now() - cursorStartedAt) / 1000, x: Math.round(p.x), y: Math.round(p.y) });
  };
  sample();
  cursorTimer = setInterval(sample, 40);
}

function stopCursorSampling() {
  if (cursorTimer) clearInterval(cursorTimer);
  cursorTimer = null;
  return cursorSamples;
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

function ffmpegCandidates() {
  const list = [];
  if (process.env.FFMPEG_PATH) list.push(process.env.FFMPEG_PATH);
  list.push('/usr/local/bin/ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/bin/ffmpeg');
  return list;
}

function findFfmpeg() {
  for (const p of ffmpegCandidates()) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {}
  }
  return null;
}

function runFfmpeg(args, onLine) {
  return new Promise((resolve, reject) => {
    const bin = findFfmpeg();
    if (!bin) return reject(new Error('ffmpeg not found'));
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      const s = d.toString();
      stderr += s;
      if (onLine) for (const line of s.split('\n')) if (line.trim()) onLine(line.trim());
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-800)}`));
    });
  });
}

// ---------------------------------------------------------------------------
// Bundled sample project
// ---------------------------------------------------------------------------

async function ensureSampleProject() {
  try {
    const dir = path.join(PROJECTS_DIR(), 'sample');
    const manifest = path.join(dir, 'project.json');
    if (fs.existsSync(manifest)) return;
    const video = path.join(__dirname, 'assets', 'sample.mp4');
    if (!fs.existsSync(video)) return;
    const cursorFile = path.join(__dirname, 'assets', 'sample.cursor.json');
    const cursor = fs.existsSync(cursorFile)
      ? JSON.parse(await fsp.readFile(cursorFile, 'utf8'))
      : [];
    await fsp.mkdir(dir, { recursive: true });
    await fsp.copyFile(video, path.join(dir, 'recording.mp4'));
    const now = Date.now();
    await saveProject({
      id: 'sample',
      name: '示例录制 · 产品演示',
      videoFile: 'recording.mp4',
      videoSize: { width: 1280, height: 800 },
      duration: 6,
      hasAudio: false,
      style: { aspect: '16:9', padding: 6, border: 0, radius: 8, shadow: 72, blur: 0, background: 'gradient-violet' },
      zooms: [],
      cursor,
      clicks: [],
      captions: [],
      cursorFx: { enabled: true, highlight: false, color: '#ffd166' },
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    console.warn('[sample] could not create the sample project:', err.message);
  }
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

let mainWindow = null;
let controlWindow = null;

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 1040,
    minHeight: 700,
    title: 'FocuSee Clone',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#eef0f5',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // preload needs require() for the vendored segmentation model
      spellcheck: false,
      // The editor is hidden while recording, but the bake loop (camera PiP
      // compositing) must keep running at full rate — otherwise the baked
      // recording becomes a ~1fps slideshow.
      backgroundThrottling: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (isE2E) runE2E(win).catch((err) => {
      console.error('[e2e] failed:', err);
      app.exit(1);
    });
    if (process.argv.includes('--e2e-open-first')) runE2EOpenFirst(win).catch((err) => {
      console.error('[e2e-open-first] failed:', err);
      app.exit(1);
    });
    if (isE2E_REC) runE2ERecording(win).catch((err) => {
      console.error('[e2e-rec] failed:', err);
      app.exit(1);
    });
  });
  win.on('closed', () => {
    mainWindow = null;
  });
  // Keep the renderer free of unhandled dialogs while the human is not around.
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url).catch(() => {});
    return { action: 'deny' };
  });
  return win;
}

/** Stop the pill's own camera preview capture — otherwise the camera stays
 *  hot after recording ends (the pill window merely hides). */
async function stopPillCameraPreview() {
  if (!controlWindow || controlWindow.isDestroyed()) return;
  try {
    // Bounded: a busy pill page must never block the recorder's teardown
    // (an unbounded await here hung the whole save once).
    await Promise.race([
      controlWindow.webContents.executeJavaScript(`
        (() => {
          const v = document.getElementById('cam-video');
          if (v && v.srcObject) {
            v.srcObject.getTracks().forEach((t) => t.stop());
            v.srcObject = null;
          }
          return true;
        })()
      `,
      3000,
    ),
    ]);
  } catch (err) {
    console.warn('[control] preview stop failed:', err.message);
  }
}

function createControlWindow() {
  const win = new BrowserWindow({
    width: 320,
    height: 76,
    resizable: true,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: true,
    backgroundColor: '#111318',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false, // keeps the bridge identical to the main window
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'control.html')).catch((err) => {
    // If the pill fails to load, the recorder would be stranded with no stop
    // control. Never leave the person without their editor: keep it visible
    // and surface the failure.
    console.error('[control] failed to load:', err.message);
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) mainWindow.show();
    if (mainWindow) mainWindow.webContents.send('record:stopRequested', { mode: 'save', reason: 'control-window-failed' });
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The recording pill must not end up inside the recording itself.
  win.setContentProtection(true);
  // Window position = where the baked-in camera PiP sits in the recording.
  const reportMove = () => {
    if (win.isDestroyed() || !win.isVisible()) return;
    const [x, y] = win.getPosition();
    const [w, h] = win.getSize();
    const display = screen.getPrimaryDisplay();
    const nx = clamp((x + w / 2 - display.bounds.x) / display.bounds.width, 0, 1);
    const ny = clamp((y + h / 2 - display.bounds.y) / display.bounds.height, 0, 1);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('record:pipMoved', { nx: Number(nx.toFixed(3)), ny: Number(ny.toFixed(3)) });
    }
  };
  win.on('moved', reportMove);
  win.on('resized', reportMove);
  const place = () => {
    const display = screen.getPrimaryDisplay().workArea;
    const [w] = win.getSize();
    win.setPosition(Math.round(display.x + display.width / 2 - w / 2), display.y + 24, false);
  };
  place();
  return win;
}

// ---------------------------------------------------------------------------
// Teleprompter (提词器): always-on-top, semi-transparent, content-protected —
// visible to the person, never captured.
// ---------------------------------------------------------------------------

let teleprompterWindow = null;

const TELEPROMPTER_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8" />
<style>
  * { box-sizing: border-box; margin: 0; }
  html, body { background: transparent; overflow: hidden; }
  body {
    font-family: -apple-system, "PingFang SC", sans-serif;
    -webkit-app-region: drag; user-select: none;
    display: flex; flex-direction: column; height: 100vh;
  }
  .bar {
    display: flex; align-items: center; gap: 8px; padding: 8px 12px;
    background: rgba(17,19,24,.92); color: #fff; border-radius: 12px;
    margin: 10px; box-shadow: 0 8px 30px rgba(0,0,0,.4);
    -webkit-app-region: no-drag; font-size: 12px;
  }
  .bar .title { font-weight: 700; margin-right: 4px; }
  .bar input[type=range] { width: 90px; accent-color: #6c5ce7; }
  .bar button { border: 0; border-radius: 6px; height: 24px; padding: 0 8px; background: rgba(255,255,255,.14); color: #fff; cursor: pointer; font-size: 11px; }
  .bar button.on { background: #6c5ce7; }
  #text {
    flex: 1; margin: 0 10px 10px; padding: 14px 18px;
    background: rgba(17,19,24,.82); color: #fff; border: 0; border-radius: 12px;
    outline: none; resize: none;
    font-size: 26px; line-height: 1.6; font-weight: 600;
    -webkit-app-region: no-drag; user-select: text;
    overflow-y: auto;
  }
</style></head><body>
  <div class="bar">
    <span class="title">提词器</span>
    <label>字号 <input type="range" id="fs" min="14" max="64" value="26" /></label>
    <label>速度 <input type="range" id="sp" min="0" max="8" value="0" /></label>
    <button id="clear">清空</button>
    <button id="close">收起</button>
  </div>
  <textarea id="text" placeholder="把讲稿粘到这里，拖动顶部条移动窗口；录制时这段画面不会被录进去。滚动速度拉到 0 以上自动滚。"></textarea>
<script>
  const fs = document.getElementById('fs');
  const text = document.getElementById('text');
  const sp = document.getElementById('sp');
  let raf = null;
  fs.addEventListener('input', () => { text.style.fontSize = fs.value + 'px'; });
  function loop() {
    const v = Number(sp.value);
    if (v > 0 && document.activeElement !== text) text.scrollTop += v * 0.25;
    raf = requestAnimationFrame(loop);
  }
  loop();
  document.getElementById('clear').addEventListener('click', () => { text.value = ''; });
  document.getElementById('close').addEventListener('click', () => window.close());
</script></body></html>`;

function createTeleprompterWindow() {
  if (teleprompterWindow && !teleprompterWindow.isDestroyed()) {
    teleprompterWindow.show();
    return teleprompterWindow;
  }
  const win = new BrowserWindow({
    width: 640,
    height: 320,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: true,
    skipTaskbar: true,
    hasShadow: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // The teleprompter is for the presenter only — exclude it from any capture.
  win.setContentProtection(true);
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(TELEPROMPTER_HTML)}`);
  win.on('closed', () => { teleprompterWindow = null; });
  teleprompterWindow = win;
  return win;
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function registerIpc() {
  ipcMain.handle('app:info', async () => ({
    version: app.getVersion(),
    forceBake: process.argv.includes('--force-bake'),
    cameraStatus: systemPreferences.getMediaAccessStatus('camera'),
    micStatus: systemPreferences.getMediaAccessStatus('microphone'),
    cameraStatus: systemPreferences.getMediaAccessStatus('camera'),
    micStatus: systemPreferences.getMediaAccessStatus('microphone'),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    dataRoot: dataRoot(),
    ffmpeg: findFfmpeg(),
    platform: process.platform,
    isE2E,
    isSmoke,
  }));

  ipcMain.handle('projects:list', async () => listProjects());

  ipcMain.handle('projects:load', async (_e, id) => loadProject(id));

  ipcMain.handle('projects:save', async (_e, project) => saveProject(project));

  ipcMain.handle('projects:delete', async (_e, id) => {
    await fsp.rm(projectDir(id), { recursive: true, force: true });
    return true;
  });

  ipcMain.handle('projects:video', async (_e, id) => {
    const p = await loadProject(id);
    const file = path.join(projectDir(id), p.videoFile);
    const data = await fsp.readFile(file);
    return { data, mime: p.videoFile.endsWith('.webm') ? 'video/webm' : 'video/mp4' };
  });

  ipcMain.handle('projects:thumb', async (_e, { id, dataUrl }) => {
    const p = await loadProject(id);
    p.thumb = dataUrl;
    await saveProject(p);
    return true;
  });

  ipcMain.handle('media:import', async (_e, { id, video, cursor }) => {
    const dir = projectDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const project = { ...video, id, cursor: cursor || [], createdAt: Date.now() };
    // video.data is a Uint8Array carried over structured clone
    await fsp.writeFile(path.join(dir, project.videoFile), Buffer.from(video.data));
    delete project.data;
    return saveProject(project);
  });

  ipcMain.handle('dialog:openVideo', async () => {
    const res = await dialog.showOpenDialog(mainWindow, {
      title: 'Import a screen recording',
      properties: ['openFile'],
      filters: [{ name: 'Video', extensions: ['mp4', 'mov', 'webm', 'm4v'] }],
    });
    if (res.canceled || !res.filePaths.length) return null;
    return res.filePaths[0];
  });

  ipcMain.handle('file:readVideo', async (_e, filePath) => {
    const data = await fsp.readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    const mime = ext === '.webm' ? 'video/webm' : 'video/mp4';
    return { data, mime, name: path.basename(filePath), size: data.length };
  });

  // Recording -------------------------------------------------------------
  // Modern desktop-capture path: the renderer calls getDisplayMedia and this
  // handler supplies the source the person picked in our own picker. This
  // avoids the legacy chromeMediaSourceId getUserMedia path, whose source
  // start intermittently times out on macOS ("Timeout starting video source").
  let pendingDisplaySource = null;
  ipcMain.on('capture:setDisplaySource', (_e, sourceId) => {
    pendingDisplaySource = sourceId || null;
  });
  session.defaultSession.setDisplayMediaRequestHandler(async (_req, opts) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 1, height: 1 } });
      const picked = pendingDisplaySource
        ? sources.find((s) => s.id === pendingDisplaySource) || sources[0]
        : sources[0];
      if (picked) opts.video = picked;
    } catch (err) {
      console.error('[capture] display handler failed:', err.message);
    }
  }, { useSystemPicker: false });

  ipcMain.handle('capture:sources', async () => {
    const fetch = () => desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: 320, height: 200 },
      fetchWindowIcons: true,
    });
    let sources;
    try {
      sources = await fetch();
    } catch (err) {
      // "Failed to get sources." right after granting Screen Recording means
      // the running process still holds its pre-grant capture session: the fix
      // is a full app restart, not another grant. Retry once after a beat in
      // case the system was mid-registration, then surface precise guidance.
      const status = systemPreferences.getMediaAccessStatus('screen');
      await new Promise((r) => setTimeout(r, 900));
      try {
        sources = await fetch();
      } catch (err2) {
        const hint = status === 'granted'
          ? '权限已授予但应用还在用授权前的旧状态：请完全退出本应用（Cmd+Q）后重新打开，再点录制。'
          : `屏幕录制权限未生效（当前状态：${status}）。请到 系统设置 → 隐私与安全性 → 屏幕录制 中允许本应用，然后完全退出并重新打开应用。`;
        const e = new Error(`${err2.message}。${hint}`);
        e.code = 'SOURCES_FAILED';
        e.mediaStatus = status;
        throw e;
      }
    }
    const displays = screen.getAllDisplays();
    return sources.map((s) => {
      const display = s.display_id
        ? displays.find((d) => String(d.id) === String(s.display_id)) || null
        : null;
      return {
        id: s.id,
        name: s.name,
        kind: s.id.startsWith('screen:') ? 'screen' : 'window',
        thumbnail: s.thumbnail.toDataURL(),
        appIcon: s.appIcon ? s.appIcon.toDataURL() : null,
        displayId: s.display_id || null,
        display: display ? { width: display.size.width, height: display.size.height } : null,
      };
    });
  });

  ipcMain.handle('capture:begin', async () => {
    startCursorSampling();
    const display = screen.getPrimaryDisplay();
    return {
      startedAt: Date.now(),
      display: { width: display.size.width, height: display.size.height },
    };
  });

  ipcMain.handle('capture:end', async () => stopCursorSampling());

  ipcMain.handle('capture:showControl', async (_e, info) => {
    if (!controlWindow) controlWindow = createControlWindow();
    controlWindow.webContents.send('control:state', info);
    controlWindow.showInactive();
    if (mainWindow) mainWindow.hide();
    return true;
  });

  ipcMain.handle('capture:updateControl', async (_e, info) => {
    if (controlWindow) controlWindow.webContents.send('control:state', info);
    return true;
  });

  ipcMain.on('capture:stopRequested', () => {
    if (mainWindow) mainWindow.webContents.send('record:stopRequested', { mode: 'save' });
  });

  ipcMain.on('capture:cancelRequested', () => {
    if (controlWindow) controlWindow.hide();
    if (mainWindow) mainWindow.webContents.send('record:stopRequested', { mode: 'cancel' });
  });

  ipcMain.handle('capture:hideControl', async () => {
    await stopPillCameraPreview();
    if (controlWindow) {
      controlWindow.hide();
    }
    if (mainWindow) mainWindow.show();
    return true;
  });

  // Export ----------------------------------------------------------------
  ipcMain.handle('export:saveWebm', async (_e, { defaultName, data }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Export video',
      defaultPath: path.join(app.getPath('movies'), defaultName || 'focusee-export.webm'),
      filters: [{ name: 'WebM video', extensions: ['webm'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, Buffer.from(data));
    return res.filePath;
  });

  ipcMain.handle('export:toMp4', async (_e, { inputPath, outputPath, onEvent }) => {
    const target = outputPath || inputPath.replace(/\.webm$/i, '.mp4');
    await runFfmpeg(
      ['-y', '-i', inputPath, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', target],
      (line) => { if (onEvent) onEvent(line); },
    );
    return target;
  });

  ipcMain.handle('export:tempFile', async (_e, { name, data }) => {
    const dir = path.join(dataRoot(), 'exports');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${Date.now()}-${name || 'export.webm'}`);
    await fsp.writeFile(file, Buffer.from(data));
    return file;
  });

  ipcMain.handle('export:reveal', async (_e, filePath) => {
    shell.showItemInFolder(filePath);
    return true;
  });

  ipcMain.handle('dialog:saveProjectFile', async (_e, { name, data }) => {
    const res = await dialog.showSaveDialog(mainWindow, {
      title: 'Save project',
      defaultPath: path.join(app.getPath('documents'), name || 'project.focusee.json'),
      filters: [{ name: 'FocuSee Clone project', extensions: ['json'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await fsp.writeFile(res.filePath, Buffer.from(data));
    return res.filePath;
  });

  ipcMain.handle('teleprompter:toggle', async () => {
    if (teleprompterWindow && !teleprompterWindow.isDestroyed() && teleprompterWindow.isVisible()) {
      teleprompterWindow.hide();
      return { visible: false };
    }
    createTeleprompterWindow();
    return { visible: true };
  });

  ipcMain.handle('projects:saveCamera', async (_e, { id, data }) => {
    const dir = projectDir(id);
    await fsp.mkdir(dir, { recursive: true });
    const file = 'camera.webm';
    await fsp.writeFile(path.join(dir, file), Buffer.from(data));
    return { cameraFile: file };
  });

  ipcMain.handle('projects:camera', async (_e, id) => {
    const p = await loadProject(id);
    if (!p.cameraFile) return null;
    const file = path.join(projectDir(id), p.cameraFile);
    const data = await fsp.readFile(file);
    return { data, mime: 'video/webm', file: p.cameraFile };
  });

  ipcMain.on('control:pipResize', (_e, delta) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('record:pipResize', { delta: Number(delta) || 0 });
    }
  });
  ipcMain.on('control:pipReport', () => {
    if (!controlWindow || controlWindow.isDestroyed() || !controlWindow.isVisible()) return;
    const [x, y] = controlWindow.getPosition();
    const [w, h] = controlWindow.getSize();
    const display = screen.getPrimaryDisplay();
    const nx = clamp((x + w / 2 - display.bounds.x) / display.bounds.width, 0, 1);
    const ny = clamp((y + h / 2 - display.bounds.y) / display.bounds.height, 0, 1);
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('record:pipMoved', { nx: Number(nx.toFixed(3)), ny: Number(ny.toFixed(3)) });
    }
  });
  ipcMain.handle('control:attachCameraPreview', async () => {
    // The control window opens its own camera capture for the live preview;
    // the recorder's camera take is independent (two captures of one camera
    // are allowed by macOS).
    try {
      const win = controlWindow && !controlWindow.isDestroyed() ? controlWindow : null;
      if (!win) return { ok: false };
      await win.webContents.executeJavaScript(
        `(async () => {
          const v = document.getElementById('cam-video');
          if (!v) return 'no-video-el';
          if (v.srcObject) return 'already';
          const s = await navigator.mediaDevices.getUserMedia({ video: { width: { ideal: 640 } }, audio: false });
          v.srcObject = s;
          return 'attached';
        })()`,
      );
      // Grow the pill window so the preview fits.
      const [w, h] = win.getSize();
      win.setMinimumSize(320, 76);
      win.setSize(w, Math.max(h, 380), false);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:get', async () => readSettings());
  ipcMain.handle('settings:set', async (_e, patch) => writeSettings(patch));

  // E2E helpers -----------------------------------------------------------
  ipcMain.handle('e2e:shot', async (_e, name) => {
    if (!mainWindow) return null;
    const img = await mainWindow.webContents.capturePage();
    // Never write inside the app bundle: anything added under Contents/
    // breaks the code seal and macOS then silently refuses screen capture.
    const dir = path.join(dataRoot(), 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${name}.png`);
    await fsp.writeFile(file, img.toPNG());
    return file;
  });
  ipcMain.handle('e2e:quit', async () => {
    setTimeout(() => app.quit(), 120);
    return true;
  });
}

// ---------------------------------------------------------------------------
// E2E scenario (deterministic, no OS screen-capture permission needed)
// ---------------------------------------------------------------------------

async function runE2E(win) {
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const artifactDir = path.join(dataRoot(), 'artifacts');
  const shot = async (name) => {
    const img = await wc.capturePage();
    await fsp.mkdir(artifactDir, { recursive: true });
    await fsp.writeFile(path.join(artifactDir, `${name}.png`), img.toPNG());
    console.log('[e2e] shot', name);
  };
  const evalJs = (code) => wc.executeJavaScript(code, true);
  await wait(1800);
  await evalJs(`window.__focuseeTest.ready()`);
  await wait(1200);
  await shot('01-home');
  await evalJs(`window.__focuseeTest.openSample()`);
  await wait(2500);
  await shot('02-editor');
  await evalJs(`window.__focuseeTest.selectTab('background')`);
  await wait(500);
  await shot('03-background');
  await evalJs(`window.__focuseeTest.selectTab('cursor')`);
  await wait(400);
  await shot('04-cursor');
  await evalJs(`window.__focuseeTest.previewZoom(2.4)`);
  await wait(600);
  await shot('05-zoomed-canvas');
  const report = await evalJs(`window.__focuseeTest.summary()`);
  console.log('[e2e] summary', JSON.stringify(report));
  await fsp.writeFile(path.join(artifactDir, 'e2e-summary.json'), JSON.stringify(report, null, 2));
  // Export one short clip to prove the render pipeline works end to end.
  if (!process.argv.includes('--e2e-no-export')) {
    const result = await evalJs(`window.__focuseeTest.exportPreview()`);
    console.log('[e2e] export', JSON.stringify(result));
    await fsp.writeFile(path.join(artifactDir, 'export-summary.json'), JSON.stringify(result, null, 2));
    await shot('06-export-done');
  }
  await wait(300);
  app.exit(0);
}

// ---------------------------------------------------------------------------
// E2E: open the newest user project (first recent card) and screenshot the
// editor — reproduces exactly what a person sees with their own data.
// ---------------------------------------------------------------------------

async function runE2EOpenFirst(win) {
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalJs = (code) => wc.executeJavaScript(code, true);
  await wait(1500);
  await evalJs(`document.querySelector('.recent-card')?.click()`);
  await wait(3500);
  const info = await evalJs(`({
    title: document.querySelector('#doc-title')?.textContent,
    canvasHasContent: (() => {
      const c = document.getElementById('canvas');
      if (!c) return null;
      const ctx = c.getContext('2d');
      const d = ctx.getImageData(Math.round(c.width * 0.75), Math.round(c.height * 0.75), 40, 40).data;
      let sum = 0; for (let i = 3; i < d.length; i += 4) sum += d[i];
      return sum / (40 * 40);
    })(),
    camEnabled: window.__focusee ? undefined : undefined,
    projectCam: (window.__projCamRef || {}),
  })`);
  console.log('[e2e-open-first]', JSON.stringify(info));
  await wait(300);
  const img = await wc.capturePage();
  const dir = path.join(dataRoot(), 'artifacts');
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'open-first.png'), img.toPNG());
  console.log('[e2e-open-first] shot saved');
  app.exit(0);
}

// ---------------------------------------------------------------------------
// E2E recording scenario: drive the real record flow end to end without a
// person (open dialog -> pick first screen -> skip countdown -> record 3s ->
// stop from the pill path -> verify the project persists).
// ---------------------------------------------------------------------------

async function runE2ERecording(win) {
  const withCamera = process.argv.includes('--e2e-rec-cam');
  const wc = win.webContents;
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const evalJs = (code) => wc.executeJavaScript(code, true);
  const report = { steps: [], withCamera };
  const step = (name, ok, extra) => { report.steps.push({ name, ok, ...(extra ? { extra } : {}) }); console.log('[e2e-rec]', name, ok ? 'ok' : 'FAIL', extra || ''); };
  try {
    await wait(1500);
    await evalJs(`document.querySelector('#btn-record').click()`);
    if (withCamera) {
      // Force the camera option on before the source grid check.
      await evalJs(`document.querySelector('#opt-camera').checked = true`);
    }
    await wait(1600);
    const picked = await evalJs(`(async () => {
      const card = document.querySelector('#source-grid .source-card[data-source^="screen"]');
      if (!card) return null;
      card.click();
      await new Promise(r => setTimeout(r, 200));
      return document.querySelector('#source-grid .source-card.active')?.dataset.source || null;
    })()`);
    step('pick-screen-source', !!picked, picked || 'no screen source card');
    if (!picked) throw new Error('no screen source');
    // Skip the countdown for determinism.
    await evalJs(`document.querySelector('#opt-countdown').checked = false`);
    await evalJs(`document.querySelector('#btn-start-record').click()`);
    // Poll for the pill: first-time source init can take several seconds.
    let pillState = null;
    for (let i = 0; i < 40 && !pillState; i += 1) {
      await wait(500);
      if (controlWindow && !controlWindow.isDestroyed() && controlWindow.isVisible()) {
        const url = controlWindow.webContents.getURL();
        if (/control\.html$/.test(url)) pillState = { pill: true, visible: true, url };
      }
      const toastText = await evalJs(`document.querySelector('#toast')?.classList.contains('hidden') ? null : document.querySelector('#toast')?.textContent`);
      if (toastText && /失败|不可用/.test(toastText)) { step('record-error', false, toastText); break; }
    }
    if (!pillState) pillState = { pill: false };
    const bridgeOk = pillState.pill
      ? await (async () => {
          try {
            return await controlWindow.webContents.executeJavaScript(`!!window.focusee && !!window.focusee.control`, true);
          } catch { return false; }
        })()
      : false;
    step('control-pill-loaded', !!(pillState.pill && /control\.html$/.test(pillState.url || '') && bridgeOk), JSON.stringify({ ...pillState, bridgeOk }));
    step('pill-bridge-alive', bridgeOk === true);
    const mainHidden = mainWindow ? !mainWindow.isVisible() : true;
    step('main-window-hidden-while-recording', mainHidden);
    await wait(2500);
    // Stop via the pill's own button (the path a person uses).
    let bakeDebug = null;
    try {
      bakeDebug = await evalJs(`window.__bakeDebug || null`);
    } catch {}
    const stopped = await new Promise((resolve) => {
      if (!controlWindow || controlWindow.isDestroyed()) return resolve('no-pill');
      controlWindow.webContents.executeJavaScript(`document.querySelector('#btn-stop').click(); 'clicked'`, true).then(resolve).catch((e) => resolve('exec:' + e.message));
    });
    step('pill-stop-clicked', stopped === 'clicked', stopped);
    if (bakeDebug) step('bake-debug', true, JSON.stringify(bakeDebug));
    // The save runs in the background after the editor is unblocked — poll.
    let rec = null;
    let saveState = null;
    for (let i = 0; i < 25 && !rec; i += 1) {
      await wait(1000);
      const projects = await listProjects();
      rec = projects.find((p) => p.id !== 'sample') || null;
      try {
        saveState = await evalJs(`window.__saveState || null`);
        const phase = await evalJs(`window.__stopPhase || null`);
        if (phase) report.stopPhase = phase;
        if (saveState && saveState.startsWith('failed')) break;
      } catch {}
    }
    step('save-state', true, saveState || 'unknown');
    step('project-saved', !!rec, rec ? `${rec.name} dur=${rec.duration?.toFixed?.(2)}` : 'none');
    report.project = rec || null;
    await wait(400);
    const dir = path.join(dataRoot(), 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'e2e-rec-report.json'), JSON.stringify(report, null, 2));
    const allOk = report.steps.every((s) => s.ok);
    console.log('[e2e-rec] ALL_OK=' + allOk);
    app.exit(allOk ? 0 : 1);
  } catch (err) {
    report.error = err.message;
    const dir = path.join(dataRoot(), 'artifacts');
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, 'e2e-rec-report.json'), JSON.stringify(report, null, 2));
    console.error('[e2e-rec] error:', err.message);
    app.exit(1);
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

protocol.registerSchemesAsPrivileged([
  { scheme: 'app-media', privileges: { standard: false, secure: true, supportFetchAPI: true, stream: true } },
  // vendored MediaPipe wasm/model: file:// fetch is CORS-blocked, so the
  // segmenter loads through this http-like privileged scheme instead.
  { scheme: 'vendor', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

// One instance at a time: a second `npm start` must focus the existing window
// instead of spawning a competing recorder.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  await ensureDirs();
  // Self-diagnostic: records what THIS process actually sees (permission status
  // and a real source probe), so a user-side failure can be compared against
  // what System Settings shows. Tiny file, rewritten on every launch.
  try {
    const mediaStatus = systemPreferences.getMediaAccessStatus('screen');
    let probe = null;
    try {
      const srcs = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 8, height: 8 } });
      probe = { ok: true, count: srcs.length };
    } catch (err) {
      probe = { ok: false, error: err.message.slice(0, 200) };
    }
    await fsp.mkdir(dataRoot(), { recursive: true });
    await fsp.writeFile(
      path.join(dataRoot(), 'diag.json'),
      JSON.stringify({ at: new Date().toISOString(), pid: process.pid, execPath: process.execPath, mediaStatus, probe }, null, 2),
    );
  } catch (err) {
    console.warn('[diag] failed:', err.message);
  }
  protocol.handle('app-media', (request) => {
    try {
      const url = new URL(request.url);
      const id = url.hostname;
      const file = decodeURIComponent(url.pathname.replace(/^\//, ''));
      return net.fetch(pathToFileURL(path.join(projectDir(id), file)).toString());
    } catch (err) {
      return new Response(`bad media url: ${err.message}`, { status: 400 });
    }
  });
  protocol.handle('vendor', (request) => {
    try {
      const rel = decodeURIComponent(new URL(request.url).pathname.replace(/^\//, ''));
      const base = path.join(__dirname, 'renderer', 'vendor');
      const file = path.resolve(base, rel);
      if (!file.startsWith(base)) return new Response('forbidden', { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    } catch (err) {
      return new Response(`bad vendor url: ${err.message}`, { status: 400 });
    }
  });
  registerIpc();
  await ensureSampleProject();
  mainWindow = createMainWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createMainWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopCursorSampling();
});
