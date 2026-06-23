const QUALITY = {
  480: { width: 854, height: 480, bitrate: 1_200_000 },
  720: { width: 1280, height: 720, bitrate: 3_000_000 },
  1080: { width: 1920, height: 1080, bitrate: 6_000_000 },
  '2k': { width: 2560, height: 1440, bitrate: 10_000_000 }
};

const SEGMENT_MS = 5000;
const AUDIO_BITRATE = 192_000;

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
  clips: [],
  selectedClip: null,
  editorClip: null,
  audioApps: [],
  notificationSounds: [],
  crop: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 },
  cropDrag: null,
  saving: false,
  stoppingForSave: false
};

const $ = (id) => document.getElementById(id);

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
  $('hotkeyBadge').textContent = s.hotkey;
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

  const audioStreams = [displayStream, micStream].filter((stream) => stream?.getAudioTracks().length);
  if (audioStreams.length) {
    state.audioContext = new AudioContext({ sampleRate: 48000 });
    const destination = state.audioContext.createMediaStreamDestination();
    for (const stream of audioStreams) {
      const source = state.audioContext.createMediaStreamSource(stream);
      source.connect(destination);
      state.audioSources.push(source);
    }
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

    const keepMs = (Number(state.settings.clipSeconds) * 1000) + SEGMENT_MS * 2;
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
    setRecorderStatus('GPU Recording', `${Math.round((state.chunks.length * SEGMENT_MS) / 1000)}s audio buffered`, true);
  };

  state.recorder.onerror = (event) => {
    setRecorderStatus('Audio recorder error', event.error?.message || 'Unknown error', false);
  };

  state.recorder.onstop = () => {
    if (!state.stoppingForSave) startAudioSegmentRecorder(mimeType);
  };

  state.recorder.start();
  state.segmentTimer = setTimeout(() => {
    if (state.recorder?.state === 'recording') state.recorder.stop();
  }, SEGMENT_MS);
}

async function startGpuRecorder() {
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

  const needsSystemAudio = Boolean(state.settings.includeAudio);
  const needsMic = Boolean(state.settings.includeMic);

  if (needsSystemAudio) {
    const audioOnlyDisplayConstraints = {
      video: {
        frameRate: 1,
        width: { ideal: 16 },
        height: { ideal: 16 }
      },
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 48000,
        channelCount: 2
      }
    };

    try {
      state.displayStream = await navigator.mediaDevices.getDisplayMedia(audioOnlyDisplayConstraints);
      state.displayStream.getVideoTracks().forEach((track) => track.enabled = false);
    } catch (error) {
      toast('Sistem sesi baslatilamadi, GPU kayit sessiz devam ediyor.');
    }
  }

  state.stream = await buildRecordingStream(state.displayStream, { includeVideo: false });
  if (state.stream.getAudioTracks().length || needsMic) startAudioSegmentRecorder(getAudioMimeType());
  syncPreviewAttachment();
  setRecorderStatus('GPU Recording', needsSystemAudio || needsMic ? 'NVENC video + audio buffer' : 'NVENC video only', true);
}

async function startRecorder() {
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
  const constraints = {
    video: {
      frameRate: state.settings.fps,
      width: { ideal: q.width },
      height: { ideal: q.height }
    },
    audio: state.settings.includeAudio
      ? {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          sampleRate: 48000,
          channelCount: 2
        }
      : false
  };

  try {
    state.displayStream = await navigator.mediaDevices.getDisplayMedia(constraints);
  } catch (error) {
    if (!state.settings.includeAudio) throw error;
    state.displayStream = await navigator.mediaDevices.getDisplayMedia({ ...constraints, audio: false });
    toast('Ses yakalama baslatilamadi, kayit sessiz devam ediyor.');
  }

  state.stream = await buildRecordingStream(state.displayStream);
  syncPreviewAttachment();
  startSegmentRecorder(getMimeType(), q.bitrate);
  setRecorderStatus('Recording', 'Segment buffer warming up', true);
}

async function saveBufferedClip() {
  if (state.saving) return;
  const isGpu = (state.settings.encoderMode || 'gpu') === 'gpu';
  if (!isGpu && !state.chunks.length) {
    toast('Buffer henuz hazir degil.');
    return;
  }

  state.saving = true;
  state.stoppingForSave = true;
  const requestedAt = Date.now();
  try {
    await stopCurrentRecorder();
    await Promise.allSettled([...state.pendingWrites]);

    const title = `Papatya-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    const result = isGpu
      ? await window.clipforge.saveGpuClip({ title, requestedAt })
      : await window.clipforge.saveBufferedClip({ title });
    renderClips(result.clips);
    if (result.clips[0]) previewClip(result.clips[0], false);
    toast('Klip kaydedildi.');
  } catch (error) {
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
    node.classList.toggle('active', node.dataset.path === state.selectedClip?.path);
  });
}

function previewClip(clip, playNow) {
  const player = $('clipPlayer');
  state.selectedClip = clip;
  highlightSelected();
  setClipNameInput(clip);
  $('selectedClip').textContent = clip.path;
  $('selectedClip').title = clip.path;
  $('emptyPlayer').classList.add('hidden');
  loadClipIntoPlayer(player, clip);
  if (playNow) player.play().catch(() => {});
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
  renderClips(clips);
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
    renderClips(result.clips);
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
    renderClips(result.clips);
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
    renderClips(result.clips);
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
  $('refreshClipsBtn').addEventListener('click', async () => renderClips(await window.clipforge.listClips()));
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
  window.clipforge.onHotkeyStatus(({ hotkey, registered }) => {
    $('settingsNote').textContent = registered ? `${hotkey} kisayolu aktif.` : `${hotkey} kisayolu baska bir uygulama tarafindan kullaniliyor.`;
  });
  window.clipforge.onGpuStatus(({ ok, message }) => {
    if (!ok) {
      $('settingsNote').textContent = `GPU kayit basarisiz: ${message}`;
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
  state.notificationSounds = init.notificationSounds || [];
  await populateMicrophones();
  await loadAudioApps();
  updateStats();
  renderClips(init.clips);

  try {
    await startRecorder();
  } catch (error) {
    setRecorderStatus('Permission needed', error.message, false);
    toast('Ekran kaydi baslatilamadi. Izinleri kontrol et.');
  }
}

boot();
