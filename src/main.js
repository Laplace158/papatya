const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, desktopCapturer, session, nativeImage, protocol, screen, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs/promises');
const fsSync = require('fs');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');
const { autoUpdater } = require('electron-updater');
const ffmpegPath = require('ffmpeg-static');
const fixWebmDuration = require('webm-duration-fix').default;

const APP_NAME = 'Papatya';
const QUALITY = {
  480: { width: 854, height: 480, bitrate: '1200k' },
  720: { width: 1280, height: 720, bitrate: '3000k' },
  1080: { width: 1920, height: 1080, bitrate: '6000k' },
  '2k': { width: 2560, height: 1440, bitrate: '10000k' }
};
const GPU_SEGMENT_SECONDS = 5;
const GPU_SEGMENT_MS = GPU_SEGMENT_SECONDS * 1000;
const DEFAULT_SETTINGS = {
  hotkey: 'F8',
  clipSeconds: 30,
  quality: '720',
  fps: 60,
  encoderMode: 'gpu',
  captureBackend: 'auto',
  includeAudio: true,
  includeMic: false,
  micDeviceId: 'default',
  excludedAudioApps: [],
  notificationSoundId: 'default',
  notificationSounds: []
};

let mainWindow;
let overlayWindow;
let tray;
let isQuitting = false;
let settings = { ...DEFAULT_SETTINGS };
let bufferState = {
  sessionId: Date.now(),
  chunks: []
};
let gpuState = {
  sessionId: Date.now(),
  process: null,
  scanner: null,
  stopping: false,
  segments: []
};
let updateCheckTimer = null;

const paths = {
  userData: () => app.getPath('userData'),
  settings: () => path.join(app.getPath('userData'), 'settings.json'),
  clips: () => path.join(app.getPath('videos'), 'Papatya Clips'),
  legacyClips: () => path.join(app.getPath('videos'), 'ClipForge Clips'),
  buffer: () => path.join(app.getPath('userData'), 'rolling-buffer'),
  gpuBuffer: () => path.join(app.getPath('userData'), 'gpu-buffer'),
  defaultSound: () => path.join(__dirname, '..', 'assets', 'clip-sound.mp3'),
  icon: () => path.join(__dirname, '..', 'assets', 'papatya.ico')
};

async function ensureDirs() {
  await fs.mkdir(paths.userData(), { recursive: true });
  await fs.mkdir(paths.clips(), { recursive: true });
  await fs.mkdir(paths.buffer(), { recursive: true });
  await fs.mkdir(paths.gpuBuffer(), { recursive: true });
  await migrateLegacyClips();
}

async function migrateLegacyClips() {
  if (!fsSync.existsSync(paths.legacyClips())) return;
  const entries = await fs.readdir(paths.legacyClips(), { withFileTypes: true }).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.webm'))
      .map(async (entry) => {
        const from = path.join(paths.legacyClips(), entry.name);
        const to = path.join(paths.clips(), entry.name);
        if (!fsSync.existsSync(to)) await fs.copyFile(from, to);
      })
  );
}

async function loadSettings() {
  try {
    const raw = await fs.readFile(paths.settings(), 'utf8');
    settings = normalizeSettings({ ...DEFAULT_SETTINGS, ...JSON.parse(raw) });
  } catch {
    settings = normalizeSettings({ ...DEFAULT_SETTINGS });
    await saveSettings(settings);
  }
}

async function saveSettings(next) {
  settings = normalizeSettings({ ...settings, ...next });
  await fs.writeFile(paths.settings(), JSON.stringify(settings, null, 2));
  registerHotkey();
  return settings;
}

function normalizeSettings(next) {
  const notificationSounds = Array.isArray(next.notificationSounds)
    ? next.notificationSounds
        .filter((sound) => sound && sound.id && sound.path)
        .map((sound) => ({
          id: String(sound.id),
          name: String(sound.name || path.basename(sound.path)),
          path: String(sound.path),
          addedAt: Number(sound.addedAt) || Date.now()
        }))
    : [];
  const ids = new Set(notificationSounds.map((sound) => sound.id));
  const notificationSoundId = next.notificationSoundId === 'default' || ids.has(String(next.notificationSoundId))
    ? String(next.notificationSoundId)
    : 'default';

  return {
    ...next,
    notificationSoundId,
    notificationSounds
  };
}

function listNotificationSounds() {
  const selectedId = settings.notificationSoundId || 'default';
  const defaultPath = paths.defaultSound();
  const sounds = [
    {
      id: 'default',
      name: 'Varsayilan bildirim',
      path: defaultPath,
      exists: fsSync.existsSync(defaultPath),
      builtin: true,
      selected: selectedId === 'default'
    }
  ];

  for (const sound of settings.notificationSounds || []) {
    sounds.push({
      ...sound,
      exists: fsSync.existsSync(sound.path),
      builtin: false,
      selected: sound.id === selectedId
    });
  }

  return sounds;
}

function selectedNotificationSoundPath() {
  const selected = listNotificationSounds().find((sound) => sound.selected && sound.exists);
  return selected?.path || paths.defaultSound();
}

async function addNotificationSound() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Bildirim sesi sec',
    properties: ['openFile'],
    filters: [
      { name: 'Ses dosyalari', extensions: ['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'webm'] },
      { name: 'Tum dosyalar', extensions: ['*'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) {
    return { settings, sounds: listNotificationSounds() };
  }

  const filePath = result.filePaths[0];
  const existing = (settings.notificationSounds || []).find((sound) => sound.path.toLowerCase() === filePath.toLowerCase());
  const id = existing?.id || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const nextSounds = existing
    ? settings.notificationSounds
    : [
        ...(settings.notificationSounds || []),
        {
          id,
          name: path.basename(filePath),
          path: filePath,
          addedAt: Date.now()
        }
      ];

  await saveSettings({ notificationSoundId: id, notificationSounds: nextSounds });
  return { settings, sounds: listNotificationSounds() };
}

async function selectNotificationSound(id) {
  const soundId = String(id || 'default');
  const exists = soundId === 'default' || (settings.notificationSounds || []).some((sound) => sound.id === soundId);
  if (!exists) throw new Error('Invalid sound');
  await saveSettings({ notificationSoundId: soundId });
  return { settings, sounds: listNotificationSounds() };
}

async function deleteNotificationSound(id) {
  const soundId = String(id || '');
  if (!soundId || soundId === 'default') {
    return { settings, sounds: listNotificationSounds() };
  }

  const nextSounds = (settings.notificationSounds || []).filter((sound) => sound.id !== soundId);
  await saveSettings({
    notificationSounds: nextSounds,
    notificationSoundId: settings.notificationSoundId === soundId ? 'default' : settings.notificationSoundId
  });
  return { settings, sounds: listNotificationSounds() };
}

function createTray() {
  const icon = nativeImage.createFromPath(paths.icon());

  tray = new Tray(icon);
  tray.setToolTip(`${APP_NAME} arka planda kayıt yapıyor`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Papatya Aç', click: showWindow },
      { label: `Save Clip (${settings.hotkey})`, click: () => triggerClipSave() },
      { type: 'separator' },
      {
        label: 'Quit',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 300,
    height: 74,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  overlayWindow.setIgnoreMouseEvents(true);
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.loadFile(path.join(__dirname, 'overlay.html'));
}

function showClipOverlay() {
  if (!overlayWindow) createOverlayWindow();
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const soundUrl = pathToFileURL(selectedNotificationSoundPath()).href;
  overlayWindow.setBounds({
    x: display.bounds.x + 18,
    y: display.bounds.y + 18,
    width: 300,
    height: 74
  });
  overlayWindow.showInactive();
  overlayWindow.webContents.executeJavaScript(`
    (() => {
      const audio = document.getElementById('tinkSound');
      if (audio) {
        const source = ${JSON.stringify(soundUrl)};
        if (audio.src !== source) audio.src = source;
        audio.currentTime = 0;
        audio.volume = 0.30;
        audio.play().catch(() => {});
      }
    })();
  `).catch(() => {});
  clearTimeout(showClipOverlay.hideTimer);
  showClipOverlay.hideTimer = setTimeout(() => overlayWindow?.hide(), 2200);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 650,
    backgroundColor: '#090b10',
    title: APP_NAME,
    icon: paths.icon(),
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function showWindow() {
  if (!mainWindow) return;
  mainWindow.show();
  mainWindow.focus();
}

function registerHotkey() {
  if (!app.isReady()) return;
  globalShortcut.unregisterAll();
  const ok = globalShortcut.register(settings.hotkey, () => triggerClipSave());
  if (mainWindow) {
    mainWindow.webContents.send('hotkey-status', { hotkey: settings.hotkey, registered: ok });
  }
}

function notifyUpdateStatus(payload) {
  if (!mainWindow) return;
  mainWindow.webContents.send('update-status', payload);
}

function hasConfiguredPublishTarget() {
  try {
    const packageJson = JSON.parse(fsSync.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    const publish = Array.isArray(packageJson.build?.publish) ? packageJson.build.publish[0] : null;
    return Boolean(publish?.provider === 'github' && publish.owner && publish.repo);
  } catch {
    return false;
  }
}

function scheduleUpdateChecks() {
  clearInterval(updateCheckTimer);
  updateCheckTimer = setInterval(() => {
    autoUpdater.checkForUpdates().catch(() => {});
  }, 1000 * 60 * 60 * 4);
}

function setupAutoUpdates() {
  if (!app.isPackaged || !hasConfiguredPublishTarget()) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    notifyUpdateStatus({ state: 'checking', message: 'Guncelleme kontrol ediliyor...' });
  });

  autoUpdater.on('update-available', (info) => {
    notifyUpdateStatus({ state: 'available', version: info.version, message: `Yeni surum bulundu: ${info.version}` });
  });

  autoUpdater.on('update-not-available', () => {
    notifyUpdateStatus({ state: 'idle', message: 'Papatya guncel.' });
  });

  autoUpdater.on('download-progress', (progress) => {
    notifyUpdateStatus({
      state: 'downloading',
      percent: Math.round(progress.percent || 0),
      message: `Guncelleme indiriliyor: ${Math.round(progress.percent || 0)}%`
    });
  });

  autoUpdater.on('update-downloaded', async (info) => {
    notifyUpdateStatus({ state: 'downloaded', version: info.version, message: `Yeni surum hazir: ${info.version}` });
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      buttons: ['Simdi yeniden baslat', 'Sonra'],
      defaultId: 0,
      cancelId: 1,
      title: 'Papatya guncellendi',
      message: `Papatya ${info.version} indirildi.`,
      detail: 'Yeniden baslatirsan yeni surum hemen kurulacak.'
    });

    if (result.response === 0) {
      isQuitting = true;
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    notifyUpdateStatus({ state: 'error', message: `Guncelleme hatasi: ${error.message}` });
  });

  autoUpdater.checkForUpdates().catch(() => {});
  scheduleUpdateChecks();
}

function triggerClipSave() {
  if (!mainWindow) return;
  mainWindow.webContents.send('save-clip');
}

function sanitizeFilePart(value) {
  return String(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim() || 'Clip';
}

function isInsideClipDir(filePath) {
  const resolved = path.resolve(filePath);
  const root = path.resolve(paths.clips());
  return resolved === root || resolved.startsWith(root + path.sep);
}

function bufferFilePath(id) {
  return path.join(paths.buffer(), `${bufferState.sessionId}-${id}.webm`);
}

async function resetBuffer() {
  bufferState = {
    sessionId: Date.now(),
    chunks: []
  };
  await fs.rm(paths.buffer(), { recursive: true, force: true });
  await fs.mkdir(paths.buffer(), { recursive: true });
  return true;
}

async function resetGpuBuffer() {
  gpuState.sessionId = Date.now();
  gpuState.segments = [];
  await fs.rm(paths.gpuBuffer(), { recursive: true, force: true });
  await fs.mkdir(paths.gpuBuffer(), { recursive: true });
}

function chooseGpuBackend(qualityKey, requestedBackend = 'auto') {
  if (requestedBackend === 'dda' || requestedBackend === 'gdigrab') return requestedBackend;
  return ['1080', '2k'].includes(qualityKey) ? 'dda' : 'gdigrab';
}

function buildGpuCaptureArgs({ backend, quality, fps, maxrate, bufsize, pattern }) {
  const inputArgs = backend === 'dda'
    ? [
        '-f', 'lavfi',
        '-i', `ddagrab=framerate=${fps}:draw_mouse=1:output_idx=0:output_fmt=8bit:allow_fallback=1`
      ]
    : [
        '-f', 'gdigrab',
        '-draw_mouse', '1',
        '-framerate', String(fps),
        '-i', 'desktop',
        '-vf', `scale=${quality.width}:${quality.height}:force_original_aspect_ratio=decrease,pad=${quality.width}:${quality.height}:(ow-iw)/2:(oh-ih)/2`
      ];

  return [
    '-hide_banner',
    '-loglevel', 'warning',
    ...inputArgs,
    '-an',
    '-c:v', 'h264_nvenc',
    '-preset', 'p1',
    '-tune', 'ull',
    '-rc', 'vbr',
    '-cq', '24',
    '-b:v', maxrate,
    '-maxrate', maxrate,
    '-bufsize', bufsize,
    '-g', String(fps * 2),
    '-bf', '0',
    '-rc-lookahead', '0',
    '-zerolatency', '1',
    '-delay', '0',
    '-f', 'segment',
    '-segment_time', String(GPU_SEGMENT_SECONDS),
    '-reset_timestamps', '1',
    '-segment_format', 'mp4',
    pattern
  ];
}

async function scanGpuSegments() {
  await fs.mkdir(paths.gpuBuffer(), { recursive: true });
  const keepMs = (Number(settings.clipSeconds) + GPU_SEGMENT_SECONDS * 3) * 1000;
  const cutoff = Date.now() - keepMs;
  const entries = await fs.readdir(paths.gpuBuffer(), { withFileTypes: true }).catch(() => []);
  const segments = [];

  await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${gpuState.sessionId}-`) && entry.name.endsWith('.mp4'))
      .map(async (entry) => {
        const filePath = path.join(paths.gpuBuffer(), entry.name);
        const stat = await fs.stat(filePath).catch(() => null);
        if (!stat) return;
        if (stat.mtimeMs < cutoff) {
          await fs.rm(filePath, { force: true }).catch(() => {});
          return;
        }
        if (stat.size > 1024) {
          segments.push({
            path: filePath,
            at: stat.mtimeMs,
            startedAt: stat.mtimeMs - GPU_SEGMENT_MS,
            endedAt: stat.mtimeMs,
            size: stat.size
          });
        }
      })
  );

  gpuState.segments = segments.sort((a, b) => a.at - b.at);
  return gpuState.segments;
}

function stopGpuCapture() {
  if (gpuState.scanner) {
    clearInterval(gpuState.scanner);
    gpuState.scanner = null;
  }

  const child = gpuState.process;
  if (!child || child.killed) {
    gpuState.process = null;
    return Promise.resolve(true);
  }

  return new Promise((resolve) => {
    const done = () => {
      if (gpuState.process === child) gpuState.process = null;
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(done, 1800);
    child.once('close', done);
    gpuState.stopping = true;
    child.kill('SIGTERM');
  });
}

async function startGpuCapture(nextSettings = {}, forcedBackend = null) {
  await stopGpuCapture();
  settings = { ...settings, ...nextSettings };
  await resetGpuBuffer();

  const qualityKey = String(settings.quality || '720').toLowerCase();
  const quality = QUALITY[qualityKey] || QUALITY[720];
  const fps = Math.max(15, Math.min(60, Number(settings.fps) || 30));
  const pattern = path.join(paths.gpuBuffer(), `${gpuState.sessionId}-%05d.mp4`);
  const maxrate = quality.bitrate;
  const bufsize = maxrate;
  const backend = forcedBackend || chooseGpuBackend(qualityKey, settings.captureBackend);
  const args = buildGpuCaptureArgs({ backend, quality, fps, maxrate, bufsize, pattern });

  const child = spawn(ffmpegPath, args, { windowsHide: true });
  child.captureBackend = backend;
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
    if (stderr.length > 6000) stderr = stderr.slice(-3000);
  });
  child.on('close', (code) => {
    const intentionalStop = gpuState.stopping;
    gpuState.stopping = false;
    if (gpuState.process === child) gpuState.process = null;
    if (!intentionalStop && code !== 0 && child.captureBackend === 'dda') {
      startGpuCapture(settings, 'gdigrab').catch((error) => {
        if (mainWindow) {
          mainWindow.webContents.send('gpu-status', { ok: false, message: error.message });
        }
      });
      return;
    }
    if (!intentionalStop && code !== 0 && mainWindow) {
      mainWindow.webContents.send('gpu-status', { ok: false, message: stderr.trim() || `NVENC exited with code ${code}` });
    }
  });

  gpuState.process = child;
  gpuState.scanner = setInterval(() => scanGpuSegments().catch(() => {}), 1500);
  setTimeout(() => scanGpuSegments().catch(() => {}), 1800);
  return { ok: true, mode: 'gpu', backend };
}

async function trimBuffer() {
  const keepMs = (Number(settings.clipSeconds) + 2) * 1000;
  const cutoff = Date.now() - keepMs;
  const keepIds = new Set();

  bufferState.chunks = bufferState.chunks.filter((chunk) => {
    const keep = chunk.at >= cutoff;
    if (keep) keepIds.add(chunk.id);
    return keep;
  });

  const files = await fs.readdir(paths.buffer(), { withFileTypes: true }).catch(() => []);
  await Promise.all(
    files
      .filter((entry) => entry.isFile())
      .filter((entry) => !keepIds.has(entry.name.replace(`${bufferState.sessionId}-`, '').replace('.webm', '')))
      .map((entry) => fs.rm(path.join(paths.buffer(), entry.name), { force: true }))
  );
}

async function writeBufferChunk(payload) {
  const id = String(payload.id);
  const filePath = bufferFilePath(id);
  await fs.writeFile(filePath, Buffer.from(payload.buffer));
  const endedAt = Number(payload.endedAt || payload.at) || Date.now();
  const startedAt = Number(payload.startedAt);
  const safeStartedAt = Number.isFinite(startedAt) ? startedAt : endedAt - GPU_SEGMENT_MS;
  const chunk = {
    id,
    at: endedAt,
    startedAt: safeStartedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - safeStartedAt),
    mimeType: payload.mimeType || 'video/webm'
  };
  bufferState.chunks.push(chunk);
  await trimBuffer();
  return {
    buffered: bufferState.chunks.length
  };
}

function concatListLine(filePath) {
  const normalized = filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
  return `file '${normalized}'`;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

async function writeClipFile(filePath, inputBuffer, mimeType) {
  try {
    const inputBlob = new Blob([inputBuffer], { type: mimeType || 'video/webm' });
    const fixedBlob = await fixWebmDuration(inputBlob);
    await fs.writeFile(filePath, Buffer.from(await fixedBlob.arrayBuffer()));
  } catch {
    await fs.writeFile(filePath, inputBuffer);
  }
}

async function saveBufferClip(payload) {
  await fs.mkdir(paths.clips(), { recursive: true });
  const cutoff = Date.now() - Number(settings.clipSeconds) * 1000;
  const ordered = bufferState.chunks
    .filter((chunk) => chunk.at >= cutoff)
    .sort((a, b) => a.at - b.at);

  if (!ordered.length) throw new Error('Buffer is empty');

  const segmentPaths = [];
  for (const chunk of ordered) {
    const chunkPath = bufferFilePath(chunk.id);
    if (fsSync.existsSync(chunkPath)) segmentPaths.push(chunkPath);
  }

  if (!segmentPaths.length) throw new Error('No segment files available');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = sanitizeFilePart(payload.title || `${APP_NAME}-${stamp}`);
  const filePath = path.join(paths.clips(), `${title}.webm`);
  const listPath = path.join(paths.buffer(), `${bufferState.sessionId}-concat.txt`);
  await fs.writeFile(listPath, segmentPaths.map(concatListLine).join('\n'));
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', filePath]);
  showClipOverlay();
  return { filePath, clips: await listClips() };
}

async function concatFiles(inputPaths, outputPath) {
  const listPath = path.join(paths.buffer(), `${Date.now()}-concat.txt`);
  await fs.writeFile(listPath, inputPaths.map(concatListLine).join('\n'));
  try {
    await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outputPath]);
  } finally {
    await fs.rm(listPath, { force: true }).catch(() => {});
  }
}

function streamStartMs(entry) {
  if (!entry) return 0;
  const startedAt = Number(entry.startedAt);
  if (Number.isFinite(startedAt)) return startedAt;
  return (Number(entry.at) || Date.now()) - GPU_SEGMENT_MS;
}

function syncOffsetSeconds(audioStartAt, videoStartAt) {
  const offsetMs = audioStartAt - videoStartAt;
  if (!Number.isFinite(offsetMs) || Math.abs(offsetMs) < 35) return 0;
  const clamped = Math.max(-GPU_SEGMENT_MS, Math.min(GPU_SEGMENT_MS, offsetMs));
  return Math.round((clamped / 1000) * 1000) / 1000;
}

async function saveGpuClip(payload) {
  await stopGpuCapture();
  await scanGpuSegments();
  await fs.mkdir(paths.clips(), { recursive: true });
  const requestedAt = Number(payload.requestedAt) || Date.now();
  const cutoff = requestedAt - Number(settings.clipSeconds) * 1000;
  const videoSegments = gpuState.segments
    .filter((segment) => segment.endedAt >= cutoff && streamStartMs(segment) <= requestedAt)
    .sort((a, b) => a.at - b.at);

  if (!videoSegments.length) throw new Error('GPU buffer is empty');

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const title = sanitizeFilePart(payload.title || `${APP_NAME}-${stamp}`);
  const filePath = path.join(paths.clips(), `${title}.mp4`);
  const tempVideoPath = path.join(paths.gpuBuffer(), `${gpuState.sessionId}-video-${stamp}.mp4`);
  await concatFiles(videoSegments.map((segment) => segment.path), tempVideoPath);

  const audioEntries = bufferState.chunks
    .filter((chunk) => chunk.endedAt >= cutoff && streamStartMs(chunk) <= requestedAt)
    .sort((a, b) => a.at - b.at)
    .filter((chunk) => fsSync.existsSync(bufferFilePath(chunk.id)));
  const audioChunks = audioEntries.map((chunk) => bufferFilePath(chunk.id));

  if (!audioChunks.length) {
    await fs.copyFile(tempVideoPath, filePath);
  } else {
    const tempAudioPath = path.join(paths.buffer(), `${bufferState.sessionId}-audio-${stamp}.webm`);
    await concatFiles(audioChunks, tempAudioPath);
    try {
      const offset = syncOffsetSeconds(streamStartMs(audioEntries[0]), streamStartMs(videoSegments[0]));
      const muxArgs = ['-y'];
      if (offset < 0) muxArgs.push('-itsoffset', String(Math.abs(offset)));
      muxArgs.push('-i', tempVideoPath);
      if (offset > 0) muxArgs.push('-itsoffset', String(offset));
      muxArgs.push(
        '-i', tempAudioPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-af', 'aresample=async=1:first_pts=0',
        '-avoid_negative_ts', 'make_zero',
        '-shortest',
        filePath
      );
      await runFfmpeg(muxArgs);
    } finally {
      await fs.rm(tempAudioPath, { force: true }).catch(() => {});
    }
  }

  await fs.rm(tempVideoPath, { force: true }).catch(() => {});
  showClipOverlay();
  return { filePath, clips: await listClips() };
}

function parseSeconds(value) {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return 0;
  return seconds;
}

function normalizeCrop(crop) {
  if (!crop || typeof crop !== 'object') return null;
  const x = Math.max(0, Math.min(1, Number(crop.x)));
  const y = Math.max(0, Math.min(1, Number(crop.y)));
  const w = Math.max(0.04, Math.min(1, Number(crop.w)));
  const h = Math.max(0.04, Math.min(1, Number(crop.h)));
  if (![x, y, w, h].every(Number.isFinite)) return null;
  return {
    x: Math.min(x, 1 - w),
    y: Math.min(y, 1 - h),
    w,
    h
  };
}

async function trimClip(payload) {
  const inputPath = path.resolve(payload.clipPath);
  if (!isInsideClipDir(inputPath) || !fsSync.existsSync(inputPath)) {
    throw new Error('Invalid clip path');
  }

  const start = parseSeconds(payload.start);
  const end = parseSeconds(payload.end);
  if (end <= start) throw new Error('End time must be after start time');

  const parsed = path.parse(inputPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const isMp4 = parsed.ext.toLowerCase() === '.mp4';
  const outputPath = path.join(paths.clips(), `${sanitizeFilePart(parsed.name)}-kirp-${stamp}${isMp4 ? '.mp4' : '.webm'}`);
  const crop = normalizeCrop(payload.crop);
  const duration = end - start;
  const args = [
    '-y',
    '-ss', String(start),
    '-i', inputPath,
    '-t', String(duration)
  ];

  if (crop && (crop.x > 0.001 || crop.y > 0.001 || crop.w < 0.999 || crop.h < 0.999)) {
    args.push(
      '-vf',
      `crop=trunc(iw*${crop.w}/2)*2:trunc(ih*${crop.h}/2)*2:trunc(iw*${crop.x}/2)*2:trunc(ih*${crop.y}/2)*2`
    );
  }

  if (isMp4) {
    args.push(
      '-c:v', 'h264_nvenc',
      '-preset', 'p3',
      '-rc', 'vbr',
      '-cq', '23',
      '-b:v', '6M',
      '-c:a', 'aac',
      '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      outputPath
    );
  } else {
    args.push(
      '-c:v', 'libvpx',
      '-b:v', '6M',
      '-deadline', 'realtime',
      '-cpu-used', '4',
      '-c:a', 'libopus',
      '-b:a', '192k',
      '-avoid_negative_ts', 'make_zero',
      outputPath
    );
  }

  await runFfmpeg(args);

  return { filePath: outputPath, clips: await listClips() };
}

async function renameClip(payload) {
  const inputPath = path.resolve(payload.clipPath);
  if (!isInsideClipDir(inputPath) || !fsSync.existsSync(inputPath)) {
    throw new Error('Invalid clip path');
  }

  const rawName = String(payload.name || '').replace(/\.(webm|mp4)$/i, '');
  const nextName = sanitizeFilePart(rawName);
  const ext = path.extname(inputPath).toLowerCase() === '.mp4' ? '.mp4' : '.webm';
  const outputPath = path.join(paths.clips(), `${nextName}${ext}`);
  if (!isInsideClipDir(outputPath)) throw new Error('Invalid clip name');

  if (outputPath.toLowerCase() !== inputPath.toLowerCase() && fsSync.existsSync(outputPath)) {
    throw new Error('Bu isim zaten var');
  }

  if (outputPath !== inputPath) await fs.rename(inputPath, outputPath);
  return { filePath: outputPath, clips: await listClips() };
}

async function stripClipAudio(payload) {
  const inputPath = path.resolve(payload.clipPath);
  if (!isInsideClipDir(inputPath) || !fsSync.existsSync(inputPath)) {
    throw new Error('Invalid clip path');
  }

  const parsed = path.parse(inputPath);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputPath = path.join(paths.clips(), `${sanitizeFilePart(parsed.name)}-sessiz-${stamp}${parsed.ext.toLowerCase() === '.mp4' ? '.mp4' : '.webm'}`);
  await runFfmpeg(['-y', '-i', inputPath, '-c:v', 'copy', '-an', outputPath]);
  return { filePath: outputPath, clips: await listClips() };
}

function listAudioApps() {
  return new Promise((resolve) => {
    const script = [
      '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;',
      'Get-Process | Where-Object { $_.MainWindowTitle } |',
      'Select-Object @{n="processId";e={[string]$_.Id}},@{n="name";e={$_.ProcessName}},@{n="title";e={$_.MainWindowTitle}} |',
      'ConvertTo-Json -Compress'
    ].join(' ');
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
      windowsHide: true
    });
    let stdout = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.on('error', () => resolve([]));
    child.on('close', () => {
      try {
        const parsed = JSON.parse(stdout || '[]');
        const rows = Array.isArray(parsed) ? parsed : [parsed];
        const seen = new Set();
        resolve(
          rows
            .filter((row) => row && row.processId && row.title && row.title !== APP_NAME)
            .map((row) => ({
              processId: String(row.processId),
              name: String(row.name || 'App'),
              title: String(row.title || row.name || 'App')
            }))
            .filter((row) => {
              const key = `${row.processId}:${row.title}`;
              if (seen.has(key)) return false;
              seen.add(key);
              return true;
            })
        );
      } catch {
        resolve([]);
      }
    });
  });
}

async function listClips() {
  await fs.mkdir(paths.clips(), { recursive: true });
  const entries = await fs.readdir(paths.clips(), { withFileTypes: true });
  const clips = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && ['.webm', '.mp4'].includes(path.extname(entry.name).toLowerCase()))
      .map(async (entry) => {
        const filePath = path.join(paths.clips(), entry.name);
        const stat = await fs.stat(filePath);
        return {
          name: entry.name,
          path: filePath,
          url: `${pathToFileURL(filePath).href}?v=${Math.round(stat.mtimeMs)}`,
          protocolUrl: `papatya://clip/${encodeURIComponent(entry.name)}?v=${Math.round(stat.mtimeMs)}`,
          size: stat.size,
          createdAt: stat.birthtimeMs
        };
      })
  );
  return clips.sort((a, b) => b.createdAt - a.createdAt);
}

function setupCaptureHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(
    async (_request, callback) => {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: 1, height: 1 }
      });
      callback({
        video: sources[0],
        audio: settings.includeAudio ? 'loopback' : false
      });
    },
    { useSystemPicker: false }
  );
}

function setupIpc() {
  ipcMain.handle('app:init', async () => ({
    settings,
    clipsPath: paths.clips(),
    clips: await listClips(),
    notificationSounds: listNotificationSounds()
  }));

  ipcMain.handle('settings:save', async (_event, next) => saveSettings(next));
  ipcMain.handle('clips:list', listClips);
  ipcMain.handle('buffer:reset', resetBuffer);
  ipcMain.handle('buffer:chunk', (_event, payload) => writeBufferChunk(payload));
  ipcMain.handle('buffer:save-clip', (_event, payload) => saveBufferClip(payload));
  ipcMain.handle('gpu:start', (_event, payload) => startGpuCapture(payload));
  ipcMain.handle('gpu:stop', stopGpuCapture);
  ipcMain.handle('gpu:save-clip', (_event, payload) => saveGpuClip(payload));

  ipcMain.handle('clip:save', async (_event, payload) => {
    await fs.mkdir(paths.clips(), { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const title = sanitizeFilePart(payload.title || `${APP_NAME}-${stamp}`);
    const filePath = path.join(paths.clips(), `${title}.webm`);
    await writeClipFile(filePath, Buffer.from(payload.buffer), payload.mimeType);
    showClipOverlay();
    return { filePath, clips: await listClips() };
  });

  ipcMain.handle('clip:delete', async (_event, clipPath) => {
    const resolved = path.resolve(clipPath);
    if (!isInsideClipDir(resolved)) throw new Error('Invalid clip path');
    await fs.rm(resolved, { force: true });
    return listClips();
  });
  ipcMain.handle('clip:rename', (_event, payload) => renameClip(payload));
  ipcMain.handle('clip:trim', (_event, payload) => trimClip(payload));
  ipcMain.handle('clip:strip-audio', (_event, payload) => stripClipAudio(payload));
  ipcMain.handle('clip:reveal', (_event, clipPath) => {
    const resolved = path.resolve(clipPath);
    if (!isInsideClipDir(resolved) || !fsSync.existsSync(resolved)) throw new Error('Invalid clip path');
    shell.showItemInFolder(resolved);
    return true;
  });
  ipcMain.handle('audio:list-apps', listAudioApps);
  ipcMain.handle('sound:list', () => listNotificationSounds());
  ipcMain.handle('sound:add', addNotificationSound);
  ipcMain.handle('sound:select', (_event, id) => selectNotificationSound(id));
  ipcMain.handle('sound:delete', (_event, id) => deleteNotificationSound(id));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:hide', () => mainWindow?.hide());
  ipcMain.handle('window:toggle-maximize', () => {
    if (!mainWindow) return false;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return mainWindow.isMaximized();
  });
}

const singleInstanceLock = app.requestSingleInstanceLock();

if (!singleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());

  app.whenReady().then(async () => {
    await ensureDirs();
    await loadSettings();
    app.setName(APP_NAME);
    app.setAppUserModelId(APP_NAME);
    protocol.registerFileProtocol('papatya', (request, callback) => {
      const url = new URL(request.url);
      if (url.hostname !== 'clip') return callback({ error: -6 });
      const name = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const filePath = path.join(paths.clips(), name);
      if (!isInsideClipDir(filePath) || !fsSync.existsSync(filePath)) return callback({ error: -6 });
      callback({ path: filePath });
    });
    setupCaptureHandler();
    setupIpc();
    createWindow();
    createOverlayWindow();
    createTray();
    registerHotkey();
    setupAutoUpdates();
  });
}

app.on('window-all-closed', () => {});

app.on('will-quit', () => {
  isQuitting = true;
  clearInterval(updateCheckTimer);
  stopGpuCapture();
  globalShortcut.unregisterAll();
});

app.on('open-file', () => showWindow());

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
});
