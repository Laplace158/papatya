const QUALITY = {
  480: { width: 854, height: 480, bitrate: 1_200_000 },
  720: { width: 1280, height: 720, bitrate: 3_000_000 },
  1080: { width: 1920, height: 1080, bitrate: 6_000_000 },
  '2k': { width: 2560, height: 1440, bitrate: 10_000_000 }
};

const SEGMENT_MS = 5000;
const AUDIO_SEGMENT_MS = 1000;
const AUDIO_BITRATE = 320_000;
const SYSTEM_AUDIO_GAIN = 1.0;
const MIC_AUDIO_GAIN = 0.14;

const state = {
  settings: null,
  stream: null,
  displayStream: null,
  micStream: null,
  audioContext: null,
  audioSources: [],
  recorder: null,
  segmentTimer: null,
  pendingWrites: new Set(),
  chunkId: 0,
  chunks: [],
  clipsPath: '',
  screenshotsPath: '',
  clips: [],
  screenshots: [],
  selectedClip: null,
  selectedShot: null,
  libraryMode: 'clips',
  editorClip: null,
  audioApps: [],
  notificationSounds: [],
  crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  cropDrag: null,
  saving: false,
  stoppingForSave: false,
  captureReady: false,
  gpuFallbackAttempted: false,
  startPromise: null,
  lastSaveAttemptAt: 0,
  logPath: ''
};

const $ = (id) => document.getElementById(id);

function debugLog(message, extra = null) {
  window.clipforge.debugLog(message, extra).catch(() => {});
}

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  setTimeout(() => node.classList.remove('show'), 2600);
}

function fmtBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function fmtTime(seconds) {
  if (!Number.isFinite(seconds)) return '00:00';
  const mins = Math.floor(seconds / 60).toString().padStart(2, '0');
  const secs = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${mins}:${secs}`;
}

function fmtQuality(value) {
  return value === '2k' ? '2K' : `${value}p`;
}

function clipBaseName(clip) {
  return (clip?.name || '').replace(/\.(webm|mp4)$/i, '');
}

function setClipNameInput(clip) {
  const input = $('clipNameInput');
  const button = $('renameSelectedBtn');
  const stripButton = $('stripAudioBtn');
  if (!input || !button) return;

  input.value = clip ? clipBaseName(clip) : '';
  input.disabled = !clip;
  button.disabled = !clip;
  if (stripButton) stripButton.disabled = !clip;
}

function setLibraryMode(mode) {
  state.libraryMode = mode === 'screenshots' ? 'screenshots' : 'clips';
  $('clipsModeBtn')?.classList.toggle('active', state.libraryMode === 'clips');
  $('shotsModeBtn')?.classList.toggle('active', state.libraryMode === 'screenshots');
  $('libraryTypeLabel').textContent = state.libraryMode === 'clips' ? 'Klipler' : 'Resimler';
  $('libraryHint').textContent = state.libraryMode === 'clips'
    ? 'Tek tık oynat, çift tık klasör'
    : 'Tek tık göster, çift tık klasör';
  $('clipNameInput').disabled = state.libraryMode !== 'clips' || !state.selectedClip;
  $('renameSelectedBtn').disabled = state.libraryMode !== 'clips' || !state.selectedClip;
  $('stripAudioBtn').disabled = state.libraryMode !== 'clips' || !state.selectedClip;
  $('deleteSelectedBtn').disabled = state.libraryMode !== 'clips' || !state.selectedClip;
  if (state.libraryMode === 'clips') hideShotPreview();
}

function clearPlayerSource(player) {
  if (!player) return;
  player.pause();
  player.removeAttribute('src');
  player.load();
}

function loadClipIntoPlayer(player, clip) {
  clearPlayerSource(player);
  player.dataset.fallbackTried = '0';
  player.src = clip.url;
  player.load();
}

function hideShotPreview() {
  const shot = $('shotPlayer');
  if (!shot) return;
  shot.style.display = 'none';
  shot.removeAttribute('src');
}

function showShotPreview(item) {
  const video = $('clipPlayer');
  const shot = $('shotPlayer');
  if (!shot || !video) return;
  video.pause();
  video.removeAttribute('src');
  video.load();
  shot.src = item.url;
  shot.style.display = 'block';
}

function tryFallbackClipUrl(player, clip) {
  if (!player || !clip?.protocolUrl || player.dataset.fallbackTried === '1') return false;
  clearPlayerSource(player);
  player.dataset.fallbackTried = '1';
  player.src = clip.protocolUrl;
  player.load();
  return true;
}

function keepEditorVideoPlaying() {
  const player = $('editorPlayer');
  if (!player || !state.editorClip || !player.src || player.error) return;
  if (player.paused) player.play().catch(() => {});
}

function updateStats() {
  const s = state.settings;
  $('durationStat').textContent = `${s.clipSeconds}s`;
  $('qualityStat').textContent = fmtQuality(s.quality);
  $('fpsStat').textContent = String(s.fps);
  $('qualityBadge').textContent = fmtQuality(s.quality);
  $('hotkeyBadge').textContent = `${s.hotkey} / ${s.screenshotHotkey || 'F9'}`;
  $('clipPathStat').textContent = state.clipsPath.split(/[\\/]/).slice(-2).join('\\');
  $('hotkeyInput').value = s.hotkey;
  $('durationInput').value = s.clipSeconds;
  $('qualityInput').value = s.quality;
  $('fpsInput').value = String(s.fps);
  $('encoderInput').value = s.encoderMode || 'gpu';
  $('audioInput').checked = Boolean(s.includeAudio);
  $('micInput').checked = Boolean(s.includeMic);
  $('micDeviceInput').value = s.micDeviceId || 'default';
  renderAudioApps(state.audioApps);
  renderNotificationSounds(state.notificationSounds);
}

function setRecorderStatus(label, detail, active = true) {
  $('recordState').textContent = label;
  $('bufferState').textContent = detail;
  $('recordDot').classList.toggle('inactive', !active);
  debugLog('status', { label, detail, active });
}

function syncPreviewAttachment() {
  const preview = $('preview');
  const studioActive = document.querySelector('#studio')?.classList.contains('active');
  const nextStream = state.settings?.encoderMode !== 'gpu' && !document.hidden && document.hasFocus() && studioActive ? state.stream : null;
  if (preview.srcObject === nextStream) return;
  preview.srcObject = nextStream;
  if (nextStream) preview.play().catch(() => {});
  else preview.pause();
}

function syncViewMedia(view) {
  if (view !== 'library') $('clipPlayer')?.pause();
  if (view !== 'editor') $('editorPlayer')?.pause();
  if (view === 'editor') requestAnimationFrame(drawCropBox);
}

function handleVisibilityChange() {
  syncPreviewAttachment();
  if (document.hidden) {
    $('clipPlayer')?.pause();
    $('editorPlayer')?.pause();
  }
}

function getMimeType() {
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8,opus')) return 'video/webm;codecs=vp8,opus';
  if (MediaRecorder.isTypeSupported('video/webm;codecs=vp8')) return 'video/webm;codecs=vp8';
  return 'video/webm';
}

function getAudioMimeType() {
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  return 'audio/webm';
}

async function getDesktopStream({ width, height, fps, includeAudio, audioOnly = false, audioSourceId = true }) {
  const source = await window.clipforge.getCaptureSource();
  debugLog('desktop-source', source);

  const videoMandatory = {
    chromeMediaSource: 'desktop',
    chromeMediaSourceId: source.id,
    minWidth: width,
    maxWidth: width,
    minHeight: height,
    maxHeight: height,
    minFrameRate: audioOnly ? 1 : fps,
    maxFrameRate: audioOnly ? 1 : fps
  };

  const audioMandatory = {
    chromeMediaSource: 'desktop',
    ...(audioSourceId ? { chromeMediaSourceId: source.id } : {})
  };

  return navigator.mediaDevices.getUserMedia({
    audio: includeAudio ? { mandatory: audioMandatory } : false,
    video: { mandatory: videoMandatory }
  });
}

async function getDisplayStream({ width, height, fps, includeAudio, audioOnly = false }) {
  const constraints = {
    video: audioOnly
      ? {
          frameRate: 1,
          width: { ideal: width },
          height: { ideal: height }
        }
      : {
          frameRate: fps,
          width: { ideal: width },
          height: { ideal: height }
        },
    audio: includeAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2
        }
      : false
  };

  return navigator.mediaDevices.getDisplayMedia(constraints);
}

async function getCaptureStream(options) {
  if (options.audioOnly) {
    try {
      const stream = await getDesktopStream(options);
      debugLog('capture-stream-ok', { method: 'desktop-source-audio-first', includeAudio: options.includeAudio });
      return stream;
    } catch (desktopError) {
      debugLog('capture-stream-desktop-audio-first-failed', { message: desktopError.message, includeAudio: options.includeAudio });
      try {
        const stream = await getDesktopStream({ ...options, audioSourceId: false });
        debugLog('capture-stream-ok', { method: 'desktop-source-audio-legacy', includeAudio: options.includeAudio });
        return stream;
      } catch (legacyError) {
        debugLog('capture-stream-desktop-audio-legacy-failed', { message: legacyError.message, includeAudio: options.includeAudio });
      }
    }
  }

  try {
    const stream = await getDisplayStream(options);
    debugLog('capture-stream-ok', { method: 'display-media', includeAudio: options.includeAudio });
    return stream;
  } catch (displayError) {
    debugLog('capture-stream-display-failed', { message: displayError.message, includeAudio: options.includeAudio });
    const stream = await getDesktopStream(options);
    debugLog('capture-stream-ok', { method: 'desktop-source', includeAudio: options.includeAudio });
    return stream;
  }
}

async function populateMicrophones() {
  const select = $('micDeviceInput');
  if (!select) return;

  const current = state.settings?.micDeviceId || select.value || 'default';
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const microphones = devices.filter((device) => device.kind === 'audioinput');
  select.innerHTML = '';

  const defaultOption = document.createElement('option');
  defaultOption.value = 'default';
  defaultOption.textContent = 'Varsayılan mikrofon';
  select.appendChild(defaultOption);

  for (const device of microphones) {
    if (!device.deviceId || device.deviceId === 'default') continue;
    const option = document.createElement('option');
    option.value = device.deviceId;
    option.textContent = device.label || `Mikrofon ${select.options.length}`;
    select.appendChild(option);
  }

  select.value = [...select.options].some((option) => option.value === current) ? current : 'default';
}

async function loadAudioApps() {
  state.audioApps = await window.clipforge.listAudioApps();
  renderAudioApps(state.audioApps);
}

async function loadNotificationSounds() {
  state.notificationSounds = await window.clipforge.listNotificationSounds();
  renderNotificationSounds(state.notificationSounds);
}

function renderAudioApps(apps) {
  const list = $('audioAppList');
  if (!list) return;

  const excludedIds = new Set((state.settings?.excludedAudioApps || []).map((app) => String(app.processId)));
  const excludedNames = new Set(
    (state.settings?.excludedAudioApps || [])
      .map((app) => String(app.name || '').toLowerCase())
      .filter(Boolean)
  );
  list.innerHTML = '';

  if (!apps.length) {
    list.innerHTML = '<div class="empty small">Açık program bulunamadı.</div>';
    updateAudioFilterNote();
    return;
  }

  for (const app of apps) {
    const id = `audio-app-${app.processId}`;
    const isExcluded = excludedIds.has(String(app.processId)) || excludedNames.has(String(app.name || '').toLowerCase());
    const row = document.createElement('label');
    const checkbox = document.createElement('input');
    const textWrap = document.createElement('span');
    const name = document.createElement('strong');
    const title = document.createElement('small');

    row.className = 'audio-app-row';
    checkbox.type = 'checkbox';
    checkbox.id = id;
    checkbox.dataset.processId = app.processId;
    checkbox.dataset.name = app.name;
    checkbox.dataset.title = app.title;
    checkbox.checked = isExcluded;
    row.classList.toggle('muted', isExcluded);
    checkbox.addEventListener('change', () => {
      row.classList.toggle('muted', checkbox.checked);
      updateAudioFilterNote();
    });
    name.textContent = app.name;
    title.textContent = app.title;
    textWrap.append(name, title);
    row.append(checkbox, textWrap);
    list.appendChild(row);
  }

  updateAudioFilterNote();
}

function collectExcludedAudioApps() {
  return [...document.querySelectorAll('#audioAppList input[type="checkbox"]:checked')].map((input) => ({
    processId: input.dataset.processId,
    name: input.dataset.name,
    title: input.dataset.title
  }));
}

function updateAudioFilterNote() {
  const note = $('audioFilterNote');
  if (!note) return;
  const selected = document.querySelectorAll('#audioAppList input[type="checkbox"]:checked').length;
  note.textContent = selected
    ? `${selected} programın sesi kayda alınmayacak. Kaydetmek için Uygula'ya bas.`
    : 'Tik attığın programların sesi kayda alınmaz.';
}

function renderNotificationSounds(sounds) {
  const list = $('notificationSoundList');
  const deleteButton = $('deleteSoundBtn');
  const note = $('soundNote');
  if (!list || !deleteButton) return;

  const selected = sounds.find((sound) => sound.selected) || sounds[0];
  list.innerHTML = '';

  if (!sounds.length) {
    list.innerHTML = '<div class="empty small">Ses yok.</div>';
    deleteButton.disabled = true;
    if (note) note.textContent = 'Ses eklemek icin Ekle.';
    return;
  }

  for (const sound of sounds) {
    const row = document.createElement('button');
    const textWrap = document.createElement('span');
    const name = document.createElement('strong');
    const pathText = document.createElement('small');

    row.type = 'button';
    row.className = 'sound-row';
    row.dataset.id = sound.id;
    row.classList.toggle('active', Boolean(sound.selected));
    row.classList.toggle('missing', !sound.exists);
    row.classList.toggle('builtin', Boolean(sound.builtin));
    name.textContent = sound.name;
    pathText.textContent = sound.builtin ? 'Papatya varsayilan' : sound.path;
    textWrap.append(name, pathText);
    row.append(textWrap);
    row.addEventListener('click', () => selectNotificationSound(sound.id));
    list.appendChild(row);
  }

  deleteButton.disabled = !selected || selected.builtin;
  if (note) {
    note.textContent = selected && !selected.exists
      ? 'Dosya bulunamadi, varsayilan ses calar.'
      : 'Dosya silinirse ustu cizilir.';
  }
}

async function addNotificationSound() {
  try {
    const result = await window.clipforge.addNotificationSound();
    state.settings = result.settings;
    state.notificationSounds = result.sounds;
    renderNotificationSounds(state.notificationSounds);
    toast('Bildirim sesi eklendi.');
  } catch (error) {
    toast(`Ses eklenemedi: ${error.message}`);
  }
}

async function selectNotificationSound(id) {
  try {
    const result = await window.clipforge.selectNotificationSound(id);
    state.settings = result.settings;
    state.notificationSounds = result.sounds;
    renderNotificationSounds(state.notificationSounds);
  } catch (error) {
    toast(`Ses secilemedi: ${error.message}`);
  }
}

async function deleteSelectedNotificationSound() {
  const selected = state.notificationSounds.find((sound) => sound.selected);
  if (!selected || selected.builtin) return;

  try {
    const result = await window.clipforge.deleteNotificationSound(selected.id);
    state.settings = result.settings;
    state.notificationSounds = result.sounds;
    renderNotificationSounds(state.notificationSounds);
    toast('Bildirim sesi listeden silindi.');
  } catch (error) {
    toast(`Ses silinemedi: ${error.message}`);
  }
}

async function cleanupCaptureStreams() {
  if (state.stream) state.stream.getTracks().forEach((track) => track.stop());
  if (state.displayStream && state.displayStream !== state.stream) state.displayStream.getTracks().forEach((track) => track.stop());
  if (state.micStream) state.micStream.getTracks().forEach((track) => track.stop());
  if (state.audioContext) await state.audioContext.close().catch(() => {});

  state.stream = null;
  state.displayStream = null;
  state.micStream = null;
  state.audioContext = null;
  state.audioSources = [];
  state.captureReady = false;
}

async function buildRecordingStream(displayStream, options = {}) {
  const includeVideo = options.includeVideo !== false;
  const mixedStream = new MediaStream();
  if (includeVideo) displayStream?.getVideoTracks().forEach((track) => mixedStream.addTrack(track));

  let micStream = null;
  if (state.settings.includeMic) {
    const micDeviceId = state.settings.micDeviceId || 'default';
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: micDeviceId === 'default' ? undefined : { exact: micDeviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2
        },
        video: false
      });
      state.micStream = micStream;
      await populateMicrophones();
    } catch {
      toast('Mikrofon baslatilamadi, kayit mikrofonsuz devam ediyor.');
    }
  }

  const hasSystemAudio = Boolean(displayStream?.getAudioTracks().length);
  const hasMicAudio = Boolean(micStream?.getAudioTracks().length);
  if (hasSystemAudio || hasMicAudio) {
    state.audioContext = new AudioContext({ sampleRate: 48000, latencyHint: 'playback' });
    const destination = state.audioContext.createMediaStreamDestination();

    if (hasSystemAudio) {
      const source = state.audioContext.createMediaStreamSource(displayStream);
      const gain = state.audioContext.createGain();
      gain.gain.value = SYSTEM_AUDIO_GAIN;
      source.connect(gain).connect(destination);
      state.audioSources.push(source, gain);
    }

    if (hasMicAudio) {
      const source = state.audioContext.createMediaStreamSource(micStream);
      const gain = state.audioContext.createGain();
      gain.gain.value = MIC_AUDIO_GAIN;
      source.connect(gain).connect(destination);
      state.audioSources.push(source, gain);
    }

    debugLog('audio-mix', {
      system: hasSystemAudio,
      mic: hasMicAudio,
      systemGain: hasSystemAudio ? SYSTEM_AUDIO_GAIN : 0,
      micGain: hasMicAudio ? MIC_AUDIO_GAIN : 0
    });
    destination.stream.getAudioTracks().forEach((track) => mixedStream.addTrack(track));
  }

  return mixedStream;
}

function stopCurrentRecorder() {
  clearTimeout(state.segmentTimer);
  if (!state.recorder || state.recorder.state === 'inactive') return Promise.resolve();
  return new Promise((resolve) => {
    state.recorder.addEventListener('stop', resolve, { once: true });
    state.recorder.stop();
  });
}

function startSegmentRecorder(mimeType, bitrate) {
  if (!state.stream || state.stream.getTracks().every((track) => track.readyState === 'ended')) return;
  const segmentStartedAt = Date.now();

  state.recorder = new MediaRecorder(state.stream, {
    mimeType,
    videoBitsPerSecond: bitrate,
    audioBitsPerSecond: AUDIO_BITRATE
  });

  state.recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;

    const at = Date.now();
    const id = String(++state.chunkId);
    state.chunks.push({ id, at, startedAt: segmentStartedAt, endedAt: at });

    const keepMs = (Number(state.settings.clipSeconds) * 1000) + SEGMENT_MS * 2;
    const cutoff = Date.now() - keepMs;
    state.chunks = state.chunks.filter((chunk) => chunk.at >= cutoff);

    const write = event.data.arrayBuffer()
      .then((buffer) => window.clipforge.writeBufferChunk({
        id,
        at,
        startedAt: segmentStartedAt,
        endedAt: at,
        mimeType: state.recorder.mimeType || event.data.type || 'video/webm',
        buffer
      }))
      .finally(() => state.pendingWrites.delete(write));

    state.pendingWrites.add(write);
    setRecorderStatus('Recording', `${Math.round((state.chunks.length * SEGMENT_MS) / 1000)}s buffered`, true);
  };

  state.recorder.onerror = (event) => {
    state.captureReady = false;
    debugLog('segment-recorder-error', { message: event.error?.message || 'Unknown error' });
    setRecorderStatus('Recorder error', event.error?.message || 'Unknown error', false);
  };

  state.recorder.onstop = () => {
    if (!state.stoppingForSave) startSegmentRecorder(mimeType, bitrate);
  };

  state.recorder.start();
  state.segmentTimer = setTimeout(() => {
    if (state.recorder?.state === 'recording') state.recorder.stop();
  }, SEGMENT_MS);
}

function startAudioSegmentRecorder(mimeType) {
  if (!state.stream || !state.stream.getAudioTracks().length) return;
  const segmentStartedAt = Date.now();

  state.recorder = new MediaRecorder(state.stream, {
    mimeType,
    audioBitsPerSecond: AUDIO_BITRATE
  });

  state.recorder.ondataavailable = (event) => {
    if (!event.data || event.data.size === 0) return;

    const at = Date.now();
    const id = String(++state.chunkId);
    state.chunks.push({ id, at, startedAt: segmentStartedAt, endedAt: at });

    const keepMs = (Number(state.settings.clipSeconds) * 1000) + AUDIO_SEGMENT_MS * 8;
    const cutoff = Date.now() - keepMs;
    state.chunks = state.chunks.filter((chunk) => chunk.at >= cutoff);

    const write = event.data.arrayBuffer()
      .then((buffer) => window.clipforge.writeBufferChunk({
        id,
        at,
        startedAt: segmentStartedAt,
        endedAt: at,
        mimeType: state.recorder.mimeType || event.data.type || 'audio/webm',
        buffer
      }))
      .finally(() => state.pendingWrites.delete(write));

    state.pendingWrites.add(write);
    setRecorderStatus('GPU Recording', `${Math.round((state.chunks.length * AUDIO_SEGMENT_MS) / 1000)}s audio buffered`, true);
  };

  state.recorder.onerror = (event) => {
    state.captureReady = false;
    debugLog('audio-recorder-error', { message: event.error?.message || 'Unknown error' });
    setRecorderStatus('Audio recorder error', event.error?.message || 'Unknown error', false);
  };

  state.recorder.onstop = () => {
    if (!state.stoppingForSave) startAudioSegmentRecorder(mimeType);
  };

  state.recorder.start();
  state.segmentTimer = setTimeout(() => {
    if (state.recorder?.state === 'recording') state.recorder.stop();
  }, AUDIO_SEGMENT_MS);
}

async function startGpuRecorder() {
  debugLog('start-gpu-recorder', { includeAudio: state.settings.includeAudio, includeMic: state.settings.includeMic });
  state.stoppingForSave = true;
  await stopCurrentRecorder();
  state.stoppingForSave = false;

  await cleanupCaptureStreams();
  await Promise.allSettled([...state.pendingWrites]);
  state.pendingWrites.clear();
  state.chunks = [];
  state.chunkId = 0;
  await window.clipforge.resetBuffer();
  await window.clipforge.startGpuCapture({
    quality: $('qualityInput')?.value || state.settings.quality,
    fps: Number($('fpsInput')?.value || state.settings.fps),
    clipSeconds: Number($('durationInput')?.value || state.settings.clipSeconds)
  });

  const q = QUALITY[state.settings.quality] || QUALITY[720];
  const needsSystemAudio = Boolean(state.settings.includeAudio);
  const needsMic = Boolean(state.settings.includeMic);
  let systemAudioStarted = false;

  if (needsSystemAudio) {
    try {
      state.displayStream = await getCaptureStream({
        width: q.width,
        height: q.height,
        fps: 1,
        includeAudio: true,
        audioOnly: true
      });
      systemAudioStarted = state.displayStream.getAudioTracks().length > 0;
      debugLog('gpu-audio-display-ok', {
        audioTracks: state.displayStream.getAudioTracks().length,
        videoTracks: state.displayStream.getVideoTracks().length
      });
    } catch (error) {
      debugLog('gpu-audio-display-failed', { message: error.message });
      toast(needsMic ? 'Sistem sesi alinamadi, mikrofonla devam ediyor.' : 'Sistem sesi alinamadi, video sessiz devam ediyor.');
    }
  }

  state.stream = await buildRecordingStream(state.displayStream, { includeVideo: false });
  if (state.stream.getAudioTracks().length || needsMic) startAudioSegmentRecorder(getAudioMimeType());
  state.captureReady = true;
  state.gpuFallbackAttempted = false;
  syncPreviewAttachment();
  const hasAudioTracks = state.stream.getAudioTracks().length > 0;
  const detail = hasAudioTracks
    ? systemAudioStarted
      ? 'NVENC video + system audio'
      : 'NVENC video + mic'
    : needsSystemAudio
      ? 'NVENC video only - sistem sesi yok'
      : 'NVENC video only';
  setRecorderStatus('GPU Recording', detail, true);
}

async function startRecorder() {
  if (state.startPromise) return state.startPromise;
  state.startPromise = startRecorderInner().finally(() => {
    state.startPromise = null;
  });
  return state.startPromise;
}

async function startRecorderInner() {
  debugLog('start-recorder', {
    encoderMode: state.settings.encoderMode,
    includeAudio: state.settings.includeAudio,
    includeMic: state.settings.includeMic
  });
  if ((state.settings.encoderMode || 'gpu') === 'gpu') {
    return startGpuRecorder();
  }

  await window.clipforge.stopGpuCapture();
  state.stoppingForSave = true;
  await stopCurrentRecorder();
  state.stoppingForSave = false;

  await cleanupCaptureStreams();
  await Promise.allSettled([...state.pendingWrites]);
  state.pendingWrites.clear();
  state.chunks = [];
  state.chunkId = 0;
  await window.clipforge.resetBuffer();

  const q = QUALITY[state.settings.quality] || QUALITY[720];
  try {
    state.displayStream = await getCaptureStream({
      width: q.width,
      height: q.height,
      fps: state.settings.fps,
      includeAudio: Boolean(state.settings.includeAudio)
    });
    debugLog('compat-display-ok', { withAudio: Boolean(state.settings.includeAudio) });
  } catch (error) {
    if (state.settings.includeAudio) {
      try {
        state.displayStream = await getCaptureStream({
          width: q.width,
          height: q.height,
          fps: state.settings.fps,
          includeAudio: false
        });
        debugLog('compat-display-audio-failed', { message: error.message });
        toast('Ses yakalama baslatilamadi, kayit sessiz devam ediyor.');
      } catch (silentError) {
        return switchCompatToGpu(silentError);
      }
    } else {
      return switchCompatToGpu(error);
    }
  }

  state.stream = await buildRecordingStream(state.displayStream);
  syncPreviewAttachment();
  startSegmentRecorder(getMimeType(), q.bitrate);
  state.captureReady = true;
  setRecorderStatus('Recording', 'Segment buffer warming up', true);
}

async function switchCompatToGpu(error) {
  debugLog('compat-failed-switch-gpu', { message: error.message });
  state.captureReady = false;
  state.settings = await window.clipforge.saveSettings({ ...state.settings, encoderMode: 'gpu', captureBackend: 'gdigrab' });
  $('encoderInput').value = 'gpu';
  updateStats();
  $('settingsNote').textContent = 'Uyumluluk modu acilmadi. GPU kayda gecildi.';
  toast('Uyumluluk modu acilmadi, GPU kayda gecildi.');
  return startGpuRecorder();
}

async function ensureRecorderActive(source) {
  if (state.captureReady) return true;
  debugLog('ensure-recorder-active', { source, encoderMode: state.settings?.encoderMode });
  try {
    await window.clipforge.show().catch(() => {});
    await startRecorder();
    return state.captureReady;
  } catch (error) {
    debugLog('ensure-recorder-failed', { source, message: error.message });
    setRecorderStatus('Kayit baslamadi', error.message, false);
    toast(`Kayit baslatilamadi. Log: ${state.logPath || 'Papatya klasoru'}`);
    throw error;
  }
}

async function saveBufferedClip() {
  if (state.saving) return;
  const now = Date.now();
  if (now - state.lastSaveAttemptAt < 1200) return;
  state.lastSaveAttemptAt = now;
  state.saving = true;
  let isGpu = false;
  try {
    await ensureRecorderActive('save-request');
    isGpu = (state.settings.encoderMode || 'gpu') === 'gpu';
  } catch {
    state.saving = false;
    return;
  }
  if (!isGpu && !state.chunks.length) {
    toast('Buffer henuz hazir degil.');
    debugLog('save-skipped-empty-buffer', { mode: 'compat' });
    state.saving = false;
    return;
  }

  state.stoppingForSave = true;
  const requestedAt = Date.now();
  try {
    debugLog('save-start', { isGpu, requestedAt });
    await stopCurrentRecorder();
    await Promise.allSettled([...state.pendingWrites]);

    const title = `Papatya-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const result = isGpu
      ? await window.clipforge.saveGpuClip({ title, requestedAt })
      : await window.clipforge.saveBufferedClip({ title });
    state.clips = result.clips;
    renderLibraryPane();
    if (result.clips[0]) previewClip(result.clips[0], false);
    debugLog('save-success', { isGpu, clipCount: result.clips.length });
    toast(result.audioSegments === 0 ? 'Klip kaydedildi, ses yok.' : 'Klip kaydedildi.');
  } catch (error) {
    state.captureReady = false;
    debugLog('save-failed', { isGpu, message: error.message });
    toast(`Kayit basarisiz: ${error.message}`);
  } finally {
    state.stoppingForSave = false;
    state.saving = false;
    if (isGpu) {
      await window.clipforge.startGpuCapture({
        quality: $('qualityInput')?.value || state.settings.quality,
        fps: Number($('fpsInput')?.value || state.settings.fps),
        clipSeconds: Number($('durationInput')?.value || state.settings.clipSeconds)
      }).catch(() => {});
    }
    if (state.stream) {
      const q = QUALITY[state.settings.quality] || QUALITY[720];
      if (isGpu) startAudioSegmentRecorder(getAudioMimeType());
      else startSegmentRecorder(getMimeType(), q.bitrate);
      state.captureReady = true;
    }
  }
}

function renderClips(clips) {
  state.clips = clips;
  if (state.selectedClip) {
    state.selectedClip = clips.find((clip) => clip.path === state.selectedClip.path) || null;
  }
  populateEditorClips();
  const grid = $('clipGrid');
  grid.innerHTML = '';

  if (!clips.length) {
    setClipNameInput(null);
    grid.innerHTML = '<div class="empty">Henuz klip yok. F8 ile ilk klibini al.</div>';
    return;
  }

  for (const clip of clips) {
    const item = document.createElement('button');
    item.className = 'clip-row';
    item.dataset.path = clip.path;
    const ext = clip.name.split('.').pop().toUpperCase();
    item.innerHTML = `
      <div class="clip-thumb">${ext}</div>
      <span>
        <strong>${clip.name}</strong>
        <small>${new Date(clip.createdAt).toLocaleString()} - ${fmtBytes(clip.size)}</small>
      </span>
    `;
    item.addEventListener('click', () => previewClip(clip, false));
    item.addEventListener('dblclick', async () => {
      previewClip(clip, false);
      await window.clipforge.revealClip(clip.path).catch(() => toast('Klasor acilamadi.'));
    });
    grid.appendChild(item);
  }

  if (state.selectedClip) highlightSelected();
  setClipNameInput(state.selectedClip);
}

function renderScreenshots(shots) {
  state.screenshots = shots;
  if (state.selectedShot) {
    state.selectedShot = shots.find((shot) => shot.path === state.selectedShot.path) || null;
  }
  const grid = $('clipGrid');
  grid.innerHTML = '';

  if (!shots.length) {
    grid.innerHTML = '<div class="empty">Henuz ekran goruntusu yok. F9 ile ilk goruntuyu al.</div>';
    $('selectedClip').textContent = 'Bir resim sec';
    $('selectedClip').removeAttribute('title');
    hideShotPreview();
    $('emptyPlayer').classList.remove('hidden');
    return;
  }

  for (const shot of shots) {
    const item = document.createElement('button');
    item.className = 'clip-row';
    item.dataset.path = shot.path;
    item.innerHTML = `
      <div class="clip-thumb">PNG</div>
      <span>
        <strong>${shot.name}</strong>
        <small>${new Date(shot.createdAt).toLocaleString()} - ${fmtBytes(shot.size)}</small>
      </span>
    `;
    item.addEventListener('click', () => previewScreenshot(shot));
    item.addEventListener('dblclick', async () => {
      previewScreenshot(shot);
      await window.clipforge.revealScreenshot(shot.path).catch(() => toast('Klasor acilamadi.'));
    });
    grid.appendChild(item);
  }

  if (state.selectedShot) highlightSelected();
}

function populateEditorClips() {
  const select = $('editorClipSelect');
  if (!select) return;
  const current = state.editorClip?.path || select.value;
  select.innerHTML = '';

  if (!state.clips.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Klip yok';
    select.appendChild(option);
    $('emptyEditor').classList.remove('hidden');
    return;
  }

  for (const clip of state.clips) {
    const option = document.createElement('option');
    option.value = clip.path;
    option.textContent = clip.name;
    select.appendChild(option);
  }

  const next = state.clips.find((clip) => clip.path === current) || state.clips[0];
  select.value = next.path;
  setEditorClip(next);
}

function highlightSelected() {
  document.querySelectorAll('.clip-row').forEach((node) => {
    const activePath = state.libraryMode === 'clips' ? state.selectedClip?.path : state.selectedShot?.path;
    node.classList.toggle('active', node.dataset.path === activePath);
  });
}

function previewClip(clip, playNow) {
  const player = $('clipPlayer');
  hideShotPreview();
  state.selectedClip = clip;
  highlightSelected();
  setClipNameInput(clip);
  $('selectedClip').textContent = clip.path;
  $('selectedClip').title = clip.path;
  $('emptyPlayer').classList.add('hidden');
  loadClipIntoPlayer(player, clip);
  if (playNow) player.play().catch(() => {});
}

function previewScreenshot(shot) {
  state.selectedShot = shot;
  highlightSelected();
  $('selectedClip').textContent = shot.path;
  $('selectedClip').title = shot.path;
  $('emptyPlayer').classList.add('hidden');
  setClipNameInput(null);
  showShotPreview(shot);
}

function renderLibraryPane() {
  setLibraryMode(state.libraryMode);
  if (state.libraryMode === 'screenshots') {
    renderScreenshots(state.screenshots);
    return;
  }
  renderClips(state.clips);
}

async function refreshLibraryPane() {
  if (state.libraryMode === 'screenshots') {
    state.screenshots = await window.clipforge.listScreenshots();
  } else {
    state.clips = await window.clipforge.listClips();
  }
  renderLibraryPane();
}

function setEditorClip(clip) {
  const player = $('editorPlayer');
  if (!player || !clip) return;
  state.editorClip = clip;
  $('trimStartInput').value = '0';
  $('trimEndInput').value = '0';
  loadClipIntoPlayer(player, clip);
  $('emptyEditor').classList.add('hidden');
  $('editorNote').textContent = clip.name;
  resetCrop();
  requestAnimationFrame(drawCropBox);
}

function getEditorDuration() {
  const duration = $('editorPlayer')?.duration;
  return Number.isFinite(duration) && duration > 0 ? duration : 0;
}

function syncEditorDuration() {
  const player = $('editorPlayer');
  if (!player || !state.editorClip) return;

  const duration = getEditorDuration();
  if (duration > 0) {
    const startInput = $('trimStartInput');
    const endInput = $('trimEndInput');
    const start = Number(startInput.value || 0);
    const end = Number(endInput.value || 0);

    if (!Number.isFinite(start) || start >= duration) startInput.value = '0';
    if (!Number.isFinite(end) || end <= 0 || end > duration) endInput.value = duration.toFixed(1);

    if (player.currentTime === 0 && duration > 0.2) {
      try {
        player.currentTime = Math.min(0.1, duration / 4);
      } catch {
        // Some WebM files do not allow seeking until the first frame is ready.
      }
    }
  }

  $('emptyEditor').classList.add('hidden');
  drawCropBox();
}

async function deleteSelectedClip() {
  if (!state.selectedClip) {
    toast('Silmek icin bir klip sec.');
    return;
  }

  const deletingPath = state.selectedClip.path;
  clearPlayerSource($('clipPlayer'));
  if (state.editorClip?.path === deletingPath) {
    clearPlayerSource($('editorPlayer'));
    state.editorClip = null;
  }

  const clips = await window.clipforge.deleteClip(deletingPath);
  state.selectedClip = null;
  $('selectedClip').textContent = 'Bir klip sec';
  $('selectedClip').removeAttribute('title');
  $('emptyPlayer').classList.remove('hidden');
  setClipNameInput(null);
  state.clips = clips;
  renderLibraryPane();
  toast('Klip silindi.');
}

async function renameSelectedClip() {
  if (!state.selectedClip) {
    toast('Ismini degistirmek icin bir klip sec.');
    return;
  }

  const name = $('clipNameInput').value.trim();
  if (!name) {
    toast('Klip adi bos olamaz.');
    return;
  }

  const oldPath = state.selectedClip.path;
  const editorWasSameClip = state.editorClip?.path === oldPath;
  clearPlayerSource($('clipPlayer'));
  if (editorWasSameClip) clearPlayerSource($('editorPlayer'));

  try {
    const result = await window.clipforge.renameClip({ clipPath: oldPath, name });
    state.clips = result.clips;
    renderLibraryPane();
    const renamed = result.clips.find((clip) => clip.path === result.filePath);
    if (renamed) {
      previewClip(renamed, false);
      if (editorWasSameClip) setEditorClip(renamed);
    }
    toast('Klip adi kaydedildi.');
  } catch (error) {
    toast(`Ad degistirme basarisiz: ${error.message}`);
    const clip = state.clips.find((item) => item.path === oldPath);
    if (clip) previewClip(clip, false);
  }
}

async function stripSelectedAudio() {
  if (!state.selectedClip) {
    toast('Sesi kaldirmak icin bir klip sec.');
    return;
  }

  $('stripAudioBtn').disabled = true;
  const oldPath = state.selectedClip.path;
  try {
    const result = await window.clipforge.stripAudio({ clipPath: oldPath });
    state.clips = result.clips;
    renderLibraryPane();
    const silentClip = result.clips.find((clip) => clip.path === result.filePath) || result.clips[0];
    if (silentClip) previewClip(silentClip, false);
    toast('Sessiz kopya kaydedildi.');
  } catch (error) {
    toast(`Ses kaldirma basarisiz: ${error.message}`);
  } finally {
    $('stripAudioBtn').disabled = !state.selectedClip;
  }
}

async function exportTrimmedClip() {
  if (!state.editorClip) {
    toast('Once editorde bir klip sec.');
    return;
  }

  const start = Number($('trimStartInput').value || 0);
  let end = Number($('trimEndInput').value || 0);
  const duration = getEditorDuration();
  if ((!Number.isFinite(end) || end <= 0) && duration > 0) {
    end = duration;
    $('trimEndInput').value = duration.toFixed(1);
  }
  if (duration > 0 && end > duration) {
    end = duration;
    $('trimEndInput').value = duration.toFixed(1);
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    toast('Baslangic ve bitis zamanini kontrol et.');
    return;
  }

  $('editorNote').textContent = 'Klip kesiliyor...';
  try {
    const result = await window.clipforge.trimClip({
      clipPath: state.editorClip.path,
      start,
      end,
      crop: state.crop
    });
    state.clips = result.clips;
    renderLibraryPane();
    const exported = result.clips.find((clip) => clip.path === result.filePath) || result.clips[0];
    if (exported) {
      setEditorClip(exported);
      previewClip(exported, false);
    }
    toast('Kesilen klip kaydedildi.');
    $('editorNote').textContent = 'Kesilen klip kaydedildi.';
  } catch (error) {
    $('editorNote').textContent = error.message;
    toast(`Kesme basarisiz: ${error.message}`);
  }
}

function resetCrop() {
  state.crop = { x: 0.05, y: 0.05, w: 0.9, h: 0.9 };
  drawCropBox();
}

function getRenderedVideoRect() {
  const player = $('editorPlayer');
  const pane = player.parentElement;
  const paneRect = pane.getBoundingClientRect();
  const videoWidth = player.videoWidth || 16;
  const videoHeight = player.videoHeight || 9;
  const paneRatio = paneRect.width / paneRect.height;
  const videoRatio = videoWidth / videoHeight;

  let width = paneRect.width;
  let height = paneRect.height;
  let left = 0;
  let top = 0;

  if (paneRatio > videoRatio) {
    width = height * videoRatio;
    left = (paneRect.width - width) / 2;
  } else {
    height = width / videoRatio;
    top = (paneRect.height - height) / 2;
  }

  return { left, top, width, height };
}

function drawCropBox() {
  const layer = $('cropLayer');
  const box = $('cropBox');
  const player = $('editorPlayer');
  if (!layer || !box || !state.editorClip || !player.videoWidth) {
    layer?.classList.remove('ready');
    return;
  }

  const rect = getRenderedVideoRect();
  layer.classList.add('ready');
  box.style.left = `${rect.left + state.crop.x * rect.width}px`;
  box.style.top = `${rect.top + state.crop.y * rect.height}px`;
  box.style.width = `${state.crop.w * rect.width}px`;
  box.style.height = `${state.crop.h * rect.height}px`;
}

function clampCrop(crop) {
  const min = 0.04;
  let x = Math.max(0, Math.min(1, crop.x));
  let y = Math.max(0, Math.min(1, crop.y));
  let w = Math.max(min, Math.min(1, crop.w));
  let h = Math.max(min, Math.min(1, crop.h));
  if (x + w > 1) x = 1 - w;
  if (y + h > 1) y = 1 - h;
  return { x, y, w, h };
}

function beginCropDrag(event) {
  if (!state.editorClip) return;
  keepEditorVideoPlaying();
  const handle = event.target.dataset.handle || 'move';
  const rect = getRenderedVideoRect();
  state.cropDrag = {
    handle,
    startX: event.clientX,
    startY: event.clientY,
    rect,
    crop: { ...state.crop }
  };
  event.preventDefault();
}

function moveCropDrag(event) {
  if (!state.cropDrag) return;
  const drag = state.cropDrag;
  const dx = (event.clientX - drag.startX) / drag.rect.width;
  const dy = (event.clientY - drag.startY) / drag.rect.height;
  let crop = { ...drag.crop };

  if (drag.handle === 'move') {
    crop.x += dx;
    crop.y += dy;
  } else {
    if (drag.handle.includes('w')) {
      crop.x += dx;
      crop.w -= dx;
    }
    if (drag.handle.includes('e')) {
      crop.w += dx;
    }
    if (drag.handle.includes('n')) {
      crop.y += dy;
      crop.h -= dy;
    }
    if (drag.handle.includes('s')) {
      crop.h += dy;
    }
  }

  state.crop = clampCrop(crop);
  drawCropBox();
}

function endCropDrag() {
  state.cropDrag = null;
}

function switchView(view) {
  document.querySelectorAll('.view').forEach((node) => node.classList.toggle('active', node.id === view));
  document.querySelectorAll('.nav-item').forEach((node) => node.classList.toggle('active', node.dataset.view === view));
  syncPreviewAttachment();
  syncViewMedia(view);
}

async function applySettings() {
  const next = {
    hotkey: $('hotkeyInput').value.trim() || 'F8',
    screenshotHotkey: state.settings?.screenshotHotkey || 'F9',
    clipSeconds: Math.max(5, Math.min(180, Number($('durationInput').value || 30))),
    quality: $('qualityInput').value,
    fps: Number($('fpsInput').value),
    encoderMode: $('encoderInput').value,
    includeAudio: $('audioInput').checked,
    includeMic: $('micInput').checked,
    micDeviceId: $('micDeviceInput').value || 'default',
    excludedAudioApps: collectExcludedAudioApps()
  };
  state.settings = await window.clipforge.saveSettings(next);
  updateStats();
  state.captureReady = false;
  await startRecorder();
  toast('Ayarlar uygulandi.');
}

function bindPlayerUi() {
  $('deleteSelectedBtn').addEventListener('click', deleteSelectedClip);
  $('renameSelectedBtn').addEventListener('click', renameSelectedClip);
  $('stripAudioBtn').addEventListener('click', stripSelectedAudio);
  $('clipNameInput').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') renameSelectedClip();
  });
}

function bindUi() {
  document.querySelectorAll('.nav-item').forEach((node) => node.addEventListener('click', () => switchView(node.dataset.view)));
  $('openLibraryBtn').addEventListener('click', () => switchView('library'));
  $('saveNowBtn').addEventListener('click', saveBufferedClip);
  $('refreshClipsBtn').addEventListener('click', refreshLibraryPane);
  $('clipsModeBtn').addEventListener('click', () => {
    if (state.libraryMode === 'clips') return;
    setLibraryMode('clips');
    renderLibraryPane();
    if (state.selectedClip) previewClip(state.selectedClip, false);
  });
  $('shotsModeBtn').addEventListener('click', () => {
    if (state.libraryMode === 'screenshots') return;
    setLibraryMode('screenshots');
    renderLibraryPane();
    if (state.selectedShot) previewScreenshot(state.selectedShot);
  });
  $('saveSettingsBtn').addEventListener('click', applySettings);
  $('refreshAudioAppsBtn').addEventListener('click', loadAudioApps);
  $('addSoundBtn').addEventListener('click', addNotificationSound);
  $('deleteSoundBtn').addEventListener('click', deleteSelectedNotificationSound);
  $('minimizeBtn').addEventListener('click', () => window.clipforge.minimize());
  $('maximizeBtn').addEventListener('click', () => window.clipforge.toggleMaximize());
  $('hideBtn').addEventListener('click', () => window.clipforge.hide());
  document.addEventListener('visibilitychange', handleVisibilityChange);
  window.addEventListener('focus', () => {
    syncPreviewAttachment();
    loadNotificationSounds().catch(() => {});
  });
  window.addEventListener('blur', syncPreviewAttachment);
  $('editorClipSelect').addEventListener('change', (event) => {
    const clip = state.clips.find((item) => item.path === event.target.value);
    if (clip) setEditorClip(clip);
  });
  $('markStartBtn').addEventListener('click', () => {
    const current = $('editorPlayer').currentTime;
    $('trimStartInput').value = current.toFixed(1);
    const end = Number($('trimEndInput').value || 0);
    const duration = getEditorDuration();
    if (duration > 0 && (!Number.isFinite(end) || end <= current)) $('trimEndInput').value = duration.toFixed(1);
  });
  $('markEndBtn').addEventListener('click', () => {
    $('trimEndInput').value = $('editorPlayer').currentTime.toFixed(1);
  });
  $('exportTrimBtn').addEventListener('click', exportTrimmedClip);
  $('resetCropBtn').addEventListener('click', resetCrop);
  $('cropBox').addEventListener('pointerdown', beginCropDrag);
  document.addEventListener('pointermove', moveCropDrag);
  document.addEventListener('pointerup', endCropDrag);
  $('editorPlayer').addEventListener('loadedmetadata', syncEditorDuration);
  $('clipPlayer').addEventListener('error', () => {
    if (tryFallbackClipUrl($('clipPlayer'), state.selectedClip)) return;
    toast('Video acilamadi.');
  });
  $('editorPlayer').addEventListener('loadeddata', () => {
    if (state.editorClip) $('editorNote').textContent = state.editorClip.name;
    drawCropBox();
  });
  $('editorPlayer').addEventListener('playing', () => {
    if (state.editorClip) $('editorNote').textContent = state.editorClip.name;
  });
  $('editorPlayer').addEventListener('error', () => {
    if (tryFallbackClipUrl($('editorPlayer'), state.editorClip)) return;
    $('editorNote').textContent = 'Video acilamadi. Klip dosyasi bozuk ya da henuz tamamlanmamis olabilir.';
    toast('Video acilamadi.');
  });
  window.addEventListener('resize', drawCropBox);
  bindPlayerUi();
}

async function boot() {
  bindUi();
  window.clipforge.onSaveClip(saveBufferedClip);
  window.clipforge.onScreenshotSaved(({ filePath, error }) => {
    if (error) {
      toast(`Ekran goruntusu kaydedilemedi: ${error}`);
      return;
    }
    if (filePath) {
      window.clipforge.listScreenshots()
        .then((shots) => {
          state.screenshots = shots;
          if (state.libraryMode === 'screenshots') renderLibraryPane();
        })
        .catch(() => {});
      toast('Ekran goruntusu kaydedildi.');
    }
  });
  window.clipforge.onHotkeyStatus(({ hotkey, screenshotHotkey, registered, screenshotRegistered }) => {
    if (registered && screenshotRegistered) {
      $('settingsNote').textContent = `${hotkey} klip, ${screenshotHotkey || 'F9'} ekran goruntusu olarak aktif.`;
      return;
    }
    const failed = [];
    if (!registered) failed.push(hotkey);
    if (!screenshotRegistered) failed.push(screenshotHotkey || 'F9');
    $('settingsNote').textContent = `${failed.join(', ')} kisayolu baska bir uygulama tarafindan kullaniliyor.`;
  });
  window.clipforge.onGpuStatus(({ ok, message }) => {
    if (!ok) {
      state.captureReady = false;
      debugLog('gpu-status-failed', { message, encoderMode: state.settings?.encoderMode });
      $('settingsNote').textContent = `GPU kayit basarisiz: ${message}`;
      const shouldTryCompat = !/video buffer|FFmpeg baslatilamadi/i.test(message || '');
      if (shouldTryCompat && state.settings?.encoderMode === 'gpu' && !state.gpuFallbackAttempted) {
        state.gpuFallbackAttempted = true;
        state.settings.encoderMode = 'compat';
        $('encoderInput').value = 'compat';
        window.clipforge.saveSettings({ ...state.settings, encoderMode: 'compat' })
          .then((nextSettings) => {
            state.settings = nextSettings;
            updateStats();
            return startRecorder();
          })
          .then(() => {
            $('settingsNote').textContent = 'GPU desteklenmedi. Uyumluluk moduna gecildi.';
            toast('GPU uyumsuzdu, Uyumluluk moduna gecildi.');
            debugLog('gpu-fallback-success');
          })
          .catch((error) => {
            $('settingsNote').textContent = `Kayit baslatilamadi. Log: ${state.logPath}`;
            toast('Kayit baslatilamadi. Log dosyasini kontrol et.');
            debugLog('gpu-fallback-failed', { message: error.message });
          });
        return;
      }
      toast('GPU kayit basarisiz, Uyumluluk modunu dene.');
    }
  });
  window.clipforge.onUpdateStatus(({ state, message }) => {
    if (message) $('settingsNote').textContent = message;
    if (state === 'available' || state === 'downloaded' || state === 'error') {
      toast(message);
    }
  });

  const init = await window.clipforge.init();
  state.settings = init.settings;
  state.clipsPath = init.clipsPath;
  state.screenshotsPath = init.screenshotsPath || '';
  state.clips = init.clips || [];
  state.screenshots = init.screenshots || [];
  state.notificationSounds = init.notificationSounds || [];
  state.logPath = init.logPath || '';
  await populateMicrophones();
  await loadAudioApps();
  updateStats();
  renderLibraryPane();
  debugLog('boot-init', { settings: state.settings, logPath: state.logPath });

  try {
    await startRecorder();
  } catch (error) {
    state.captureReady = false;
    debugLog('boot-start-failed', { message: error.message });
    setRecorderStatus('Permission needed', error.message, false);
    $('settingsNote').textContent = `Kayit baslamadi. Log: ${state.logPath}`;
    toast('Ekran kaydi baslatilamadi. Izinleri kontrol et.');
  }
}

window.addEventListener('error', (event) => {
  debugLog('window-error', {
    message: event.message,
    filename: event.filename,
    line: event.lineno,
    column: event.colno
  });
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  debugLog('window-rejection', {
    message: reason?.message || String(reason),
    stack: reason?.stack || ''
  });
});

boot();
