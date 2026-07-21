// ================================================================
// Lightners Live — Web Edition
// A browser recreation of the Godot "Lightners Live" rhythm game.
// ================================================================

// ---------------- Config / constants (mirrors Global.gd) ----------------
const PERFECT_WINDOW = 0.20;
const GOOD_WINDOW = 0.35;
const PERFECT_SCORE = 50;
const GOOD_SCORE = 25;
const HOLD_SCORE_PER_SECOND = 10.0;
// How often a sustained hold is chopped into discrete pieces. Bumped up from
// 0.08s so long holds don't flood activeNotes with hundreds of near-identical
// objects (a big source of the in-game lag during rapid/rolled sections).
const HOLD_SCORE_INTERVAL = 0.12;
const AUDIO_DELAY = 2.3;        // seconds a note takes to fall to the hit line (lower = falls faster)
const AUDIO_START_DELAY = 1.1;  // seconds before the song audio begins playing

const CANVAS_W = 640, CANVAS_H = 480;

// Lane / board geometry (derived from the original Godot scene layout)
const LANE_X = { left: 292, right: 348 };
// Notes now spawn above the visible board (negative Y) and travel a longer
// distance in less time, which — combined with the shorter AUDIO_DELAY above —
// roughly triples the fall speed and, more importantly, the *pixel gap*
// between notes that are close together in time, so fast runs no longer
// visually stack/overlap on the board.
const SPAWN_Y = -30;
const HIT_Y = 325;
const FALL_RATE = (HIT_Y - SPAWN_Y) / AUDIO_DELAY; // px/sec
const DESPAWN_Y = HIT_Y + FALL_RATE * (GOOD_WINDOW + 0.5);
const BOARD_RECT = { x: 260, y: 11, w: 120, h: 356 };

const KEY_BINDINGS = {
  left: ['ArrowLeft', 'KeyZ', 'KeyA', 'KeyF', 'KeyS'],
  right: ['ArrowRight', 'KeyX', 'KeyD', 'KeyJ', 'KeyK'],
};

const BUILTIN_SONGS = [
  { id: 'bat', name: 'Raise Up Your Bat', mid: 'assets/audio/bat/chart.mid', mp3: 'assets/audio/bat/song.mp3' },
  { id: 'asgore', name: 'ASGORE', mid: 'assets/audio/asgore/chart.mid', mp3: 'assets/audio/asgore/song.mp3' },
  { id: 'hopes', name: 'Hopes and Dreams', mid: 'assets/audio/hopes/chart.mid', mp3: 'assets/audio/hopes/song.mp3' },
  {
    id: 'cutie', name: 'Cutie Mew Mew Magic',
    mid: 'assets/audio/cutie/chart.mid', mp3: 'assets/audio/cutie/song.mp3', cover: 'assets/audio/cutie/cover.jpg',
    difficulty: 'Very Hard', composer: 'Toby Fox', description: 'T-Rank 93,000 \u00b7 S-Rank 91,000',
  },
];

// ---------------- Asset loading ----------------
const IMG = {};
const SPRITE_NAMES = [
  'bg_frame1',
  'rhythmboard_frame0', 'rhythmboard_frame1',
  'kris_idle', 'kris_idle2', 'kris_low_note_down', 'kris_low_note_up', 'kris_high_note_down', 'kris_high_note_up',
  'susie_idle', 'susie_sway1', 'susie_sway2', 'susie_clap1', 'susie_clap2',
  'ralsei_idle', 'ralsei_sway1', 'ralsei_sway2', 'ralsei_clap1', 'ralsei_clap2',
];
for (let i = 0; i < 18; i++) SPRITE_NAMES.push('note_frame' + i);
for (const anim of ['perfect', 'almost', 'miss']) {
  for (let i = 0; i < 5; i++) SPRITE_NAMES.push(`hitfx_${anim}_${i}`);
}

// ---------------- Audio engine (Web Audio API) ----------------
// Everything — the song and the hit SFX — is decoded into an AudioBuffer and
// played through AudioBufferSourceNodes instead of <audio> elements. Two big
// wins over the old HTMLAudioElement approach:
//   1) The song is scheduled sample-accurately via audioCtx.currentTime, and
//      the entire game clock (songTimeNow) is derived from that SAME clock,
//      so notes can never drift out of sync with the music — there's nothing
//      left to desync, since visuals and audio share one clock.
//   2) Hit SFX fire via lightweight one-shot buffer sources instead of
//      resetting/replaying <audio> elements, which removes the frame-jank
//      that showed up when mashing/rolling notes quickly in a row.
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
function unlockAudioCtx() {
  if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
}

async function fetchArrayBufferWithProgress(url, onProgress) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('failed to fetch audio');
  const total = Number(resp.headers.get('content-length')) || 0;
  if (!resp.body || !total) return await resp.arrayBuffer();
  const reader = resp.body.getReader();
  const chunks = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received / total);
  }
  const out = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out.buffer;
}

async function loadAudioBufferFromUrl(url, onProgress) {
  const arrayBuf = await fetchArrayBufferWithProgress(url, onProgress || (() => {}));
  return decodeSongAsset(arrayBuf, new Blob([arrayBuf], { type: guessAudioMime(url) }));
}

async function loadAudioBufferFromFile(file, onProgress) {
  onProgress && onProgress(0.15);
  const arrayBuf = await file.arrayBuffer();
  onProgress && onProgress(0.6);
  const asset = await decodeSongAsset(arrayBuf, file);
  onProgress && onProgress(1);
  return asset;
}

// Some real-world audio files (odd encoder padding, uncommon tag layouts,
// etc.) get rejected by Web Audio's strict decodeAudioData even though the
// browser's own <audio> element plays them back fine. Strip any ID3v2 tag
// first (a common trip-up) and, if decoding still fails, fall back to an
// <audio>-element-backed source so the song still plays instead of silently
// not loading.
function stripId3v2(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  if (bytes.length > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const size = ((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f);
    const start = 10 + size;
    if (start > 10 && start < bytes.length) return bytes.slice(start).buffer;
  }
  return arrayBuffer;
}

function guessAudioMime(name) {
  const lower = name.toLowerCase();
  if (lower.endsWith('.wav')) return 'audio/wav';
  if (lower.endsWith('.ogg')) return 'audio/ogg';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.flac')) return 'audio/flac';
  return 'audio/mpeg';
}

async function decodeSongAsset(arrayBuffer, blobForFallback) {
  try {
    const buffer = await audioCtx.decodeAudioData(stripId3v2(arrayBuffer.slice(0)));
    return { mode: 'buffer', buffer };
  } catch (err) {
    if (!blobForFallback) throw err;
    return { mode: 'element', blob: blobForFallback };
  }
}

let sfxBuffers = { left: null, right: null };
async function preloadSfx() {
  try {
    const [left, right] = await Promise.all([
      loadAudioBufferFromUrl('assets/audio/sfx/left_hit.wav'),
      loadAudioBufferFromUrl('assets/audio/sfx/right_hit.wav'),
    ]);
    sfxBuffers.left = left.mode === 'buffer' ? left.buffer : null;
    sfxBuffers.right = right.mode === 'buffer' ? right.buffer : null;
  } catch (e) { /* SFX are non-critical; game still works without them */ }
}

function playSfx(lane) {
  const buf = sfxBuffers[lane];
  if (!buf || audioCtx.state !== 'running') return;
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  const gain = audioCtx.createGain();
  gain.gain.value = 0.35;
  src.connect(gain).connect(audioCtx.destination);
  src.start();
}

function stopSongPlayback() {
  if (state.songSource) {
    try { state.songSource.stop(); } catch (e) { /* already stopped */ }
    state.songSource.disconnect();
    state.songSource = null;
  }
}

function stopAllAudio() {
  stopSongPlayback();
  if (state.mediaEl) {
    try { state.mediaEl.pause(); } catch (e) { /* ignore */ }
    state.mediaEl.src = '';
    state.mediaEl = null;
  }
}

// Schedules the currently-loaded song buffer to start at a precise point on
// the AudioContext's own clock (atCtxTime), sample-accurate — no polling.
function scheduleSongPlayback(atCtxTime, offset) {
  stopSongPlayback();
  if (!state.audioBuffer) return;
  const src = audioCtx.createBufferSource();
  src.buffer = state.audioBuffer;
  src.connect(audioCtx.destination);
  src.start(Math.max(audioCtx.currentTime, atCtxTime), Math.max(0, offset || 0));
  state.songSource = src;
}

function loadImage(src) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

async function preloadSprites() {
  await Promise.all(SPRITE_NAMES.map(async (name) => {
    IMG[name] = await loadImage(`assets/sprites/${name}.png`);
  }));
}

// note sprite frame mapping (from Notes.png atlas slicing)
const NOTE_FRAME = { left: 9, right: 0, leftHold: 15, rightHold: 6 };

// ---------------- DOM refs ----------------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

const menuScreen = document.getElementById('menu-screen');
const gameScreen = document.getElementById('game-screen');
const songListEl = document.getElementById('song-list');
const loadingOverlay = document.getElementById('loading-overlay');
const loadingStatusEl = document.getElementById('loading-status');
const pauseOverlay = document.getElementById('pause-overlay');
const endOverlay = document.getElementById('end-overlay');
const finalScoreEl = document.getElementById('final-score');

// ---------------- Game state ----------------
const state = {
  phase: 'menu', // menu | perform | paused | ended
  chart: null,
  tapIndex: 0,
  holdIndex: 0,
  activeNotes: [], // {lane, isHold, holdId, targetTime, hit, missed, spawnTime}
  score: 0,
  combo: 0,
  gameStartCtxTime: 0,
  audioBuffer: null,
  songSource: null,
  audioMode: 'buffer',       // 'buffer' (Web Audio, sample-accurate) or 'element' (fallback)
  mediaEl: null,
  mediaStarted: false,
  mediaGameStartPerf: 0,
  mediaPausedAt: 0,
  leftCount: 0, rightCount: 0, // number of physical/touch inputs currently holding each lane
  leftHeld: false, rightHeld: false,
  kris: { anim: 'idle', until: 0 },
  hitFx: { left: null, right: null }, // {anim, frame, startTime}
  judgePop: null, // {text, color, x, y, startTime}
  sfx: { left: null, right: null },
  songMeta: null,
};

function resetChartState() {
  state.tapIndex = 0;
  state.holdIndex = 0;
  state.activeNotes = [];
  state.score = 0;
  state.combo = 0;
  state.kris.anim = 'idle';
  state.hitFx.left = null;
  state.hitFx.right = null;
  state.judgePop = null;
}

// ---------------- Menu setup ----------------
function buildSongList() {
  songListEl.innerHTML = '';
  for (const song of BUILTIN_SONGS) {
    const card = document.createElement('div');
    card.className = 'song-card';
    const cover = song.cover ? `<img class="cover" src="${song.cover}" alt="">` : '';
    const meta = [song.difficulty, song.composer].filter(Boolean).join(' \u2022 ');
    card.innerHTML = `
      ${cover}
      <span class="song-info">
        <span class="name">${song.name}</span>
        ${meta ? `<span class="meta">${meta}</span>` : ''}
      </span>
      <span class="play-icon">&#9654;</span>`;
    card.addEventListener('click', () => startBuiltinSong(song));
    songListEl.appendChild(card);
  }
}

async function startBuiltinSong(song) {
  unlockAudioCtx(); // must happen synchronously off the click gesture
  showLoading(true, 'Loading chart…');
  try {
    const [midiBuf, chart] = await loadSongChart(song.mid);
    const audioAsset = await loadAudioBufferFromUrl(song.mp3, (frac) => setLoadingProgress(frac, 'Loading audio'));
    launchGame(chart, audioAsset, song.name, { difficulty: song.difficulty, composer: song.composer, description: song.description });
  } catch (err) {
    alert('Could not load song: ' + err.message);
  } finally {
    showLoading(false);
  }
}

async function loadSongChart(midUrl) {
  const resp = await fetch(midUrl);
  if (!resp.ok) throw new Error('failed to fetch chart');
  const buf = await resp.arrayBuffer();
  const parsed = parseMidi(buf);
  const chart = buildChartFromMidi(parsed, { holdSpawnInterval: HOLD_SPAWN_INTERVAL_CFG() });
  return [buf, chart];
}

function HOLD_SPAWN_INTERVAL_CFG() { return HOLD_SCORE_INTERVAL; }

function showLoading(show, text) {
  loadingOverlay.classList.toggle('hidden', !show);
  if (loadingStatusEl) loadingStatusEl.textContent = text || '';
}

function setLoadingProgress(frac, label) {
  if (!loadingStatusEl) return;
  loadingStatusEl.textContent = `${label} ${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`;
}

// ---------------- Custom map handling ----------------
const customMidiInput = document.getElementById('custom-midi-input');
const customAudioInput = document.getElementById('custom-audio-input');
const customTitleInput = document.getElementById('custom-title-input');
const customInfoInput = document.getElementById('custom-info-input');
const customPlayBtn = document.getElementById('custom-play-btn');
const customStatus = document.getElementById('custom-status');

let customMidiFile = null, customAudioFile = null, customInfoFile = null;

customMidiInput.addEventListener('change', () => {
  customMidiFile = customMidiInput.files[0] || null;
  refreshCustomState();
});
customAudioInput.addEventListener('change', () => {
  customAudioFile = customAudioInput.files[0] || null;
  refreshCustomState();
});
customInfoInput.addEventListener('change', () => {
  customInfoFile = customInfoInput.files[0] || null;
});
function refreshCustomState() {
  customPlayBtn.disabled = !(customMidiFile && customAudioFile);
  customStatus.textContent = '';
}

// Parses the simple "key: value" info.txt format used alongside song
// packages (difficulty / description / Composer / volume / order).
function parseSongInfoText(text) {
  const info = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key && value) info[key] = value;
  }
  return info;
}

customPlayBtn.addEventListener('click', async () => {
  if (!customMidiFile || !customAudioFile) return;
  unlockAudioCtx(); // must happen synchronously off the click gesture
  showLoading(true, 'Loading chart…');
  customStatus.textContent = '';
  try {
    const buf = await customMidiFile.arrayBuffer();
    const parsed = parseMidi(buf);
    const chart = buildChartFromMidi(parsed, { holdSpawnInterval: HOLD_SCORE_INTERVAL });
    if (chart.taps.length === 0 && chart.holdPieces.length === 0) {
      customStatus.textContent = 'No recognized notes found (expects note numbers 38/36/39/35).';
      showLoading(false);
      return;
    }
    const audioAsset = await loadAudioBufferFromFile(customAudioFile, (frac) => setLoadingProgress(frac, 'Loading audio'));
    let info = {};
    if (customInfoFile) {
      try { info = parseSongInfoText(await customInfoFile.text()); } catch (e) { /* ignore malformed info.txt */ }
    }
    const title = customTitleInput.value.trim() || customMidiFile.name.replace(/\.[^.]+$/, '');
    launchGame(chart, audioAsset, title, { difficulty: info.difficulty, composer: info.composer, description: info.description });
  } catch (err) {
    customStatus.textContent = 'Error: ' + err.message;
  } finally {
    showLoading(false);
  }
});

// ---------------- Custom map: song zip bundle ----------------
const customZipInput = document.getElementById('custom-zip-input');
customZipInput.addEventListener('change', async () => {
  const zipFile = customZipInput.files[0];
  if (!zipFile) return;
  unlockAudioCtx(); // must happen synchronously off the change/click gesture
  customStatus.textContent = '';
  showLoading(true, 'Reading zip…');
  try {
    if (typeof JSZip === 'undefined') throw new Error('zip support failed to load (check your connection)');
    const zip = await JSZip.loadAsync(zipFile);
    let midEntry = null, audioEntry = null, infoEntry = null;
    zip.forEach((relPath, entry) => {
      if (entry.dir) return;
      const lower = relPath.toLowerCase();
      if (!midEntry && /\.(mid|midi)$/.test(lower)) midEntry = entry;
      else if (!audioEntry && /\.(mp3|wav|ogg|m4a|flac)$/.test(lower)) audioEntry = entry;
      else if (!infoEntry && lower.endsWith('.txt')) infoEntry = entry;
    });
    if (!midEntry) throw new Error('No .mid chart found inside the zip');
    if (!audioEntry) throw new Error('No audio file found inside the zip');

    showLoading(true, 'Extracting chart…');
    const midBuf = await midEntry.async('arraybuffer');
    const parsed = parseMidi(midBuf);
    const chart = buildChartFromMidi(parsed, { holdSpawnInterval: HOLD_SCORE_INTERVAL });
    if (chart.taps.length === 0 && chart.holdPieces.length === 0) {
      throw new Error('No recognized notes found in chart (expects note numbers 38/36/39/35).');
    }

    showLoading(true, 'Decoding audio…');
    const audioBytes = await audioEntry.async('uint8array');
    const audioMime = guessAudioMime(audioEntry.name);
    const audioAsset = await decodeSongAsset(audioBytes.buffer, new Blob([audioBytes], { type: audioMime }));

    let info = {};
    if (infoEntry) {
      try { info = parseSongInfoText(await infoEntry.async('text')); } catch (e) { /* ignore malformed info.txt */ }
    }
    const title = info.title || zipFile.name.replace(/\.zip$/i, '');
    launchGame(chart, audioAsset, title, { difficulty: info.difficulty, composer: info.composer, description: info.description });
  } catch (err) {
    customStatus.textContent = 'Error: ' + err.message;
  } finally {
    showLoading(false);
    customZipInput.value = '';
  }
});

// ---------------- Launching gameplay ----------------
function launchGame(chart, audioAsset, title, meta) {
  state.chart = chart;
  state.songMeta = { title, ...meta };
  resetChartState();
  menuScreen.classList.add('hidden');
  gameScreen.classList.remove('hidden');
  pauseOverlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
  state.phase = 'perform';
  state.audioMode = audioAsset.mode;
  if (audioAsset.mode === 'buffer') {
    state.audioBuffer = audioAsset.buffer;
    state.gameStartCtxTime = audioCtx.currentTime;
    // Schedule the song sample-accurately on the audio clock itself — the note
    // fall timing (songTimeNow, below) is driven by this exact same clock, so
    // there is no separate "poll and call .play()" step left to drift.
    scheduleSongPlayback(state.gameStartCtxTime + AUDIO_START_DELAY, 0);
  } else {
    // Fallback path for audio files the strict Web Audio decoder rejected:
    // play through a plain <audio> element instead, timed off performance.now().
    state.audioBuffer = null;
    const el = new Audio(URL.createObjectURL(audioAsset.blob));
    el.preload = 'auto';
    state.mediaEl = el;
    state.mediaStarted = false;
    state.mediaGameStartPerf = performance.now();
  }
  updateScoreDisplay();
  resizeCanvas();
  requestAnimationFrame(loop);
}

function quitToMenu() {
  stopAllAudio();
  state.audioBuffer = null;
  state.phase = 'menu';
  gameScreen.classList.add('hidden');
  pauseOverlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
  menuScreen.classList.remove('hidden');
}

// ---------------- Time ----------------
// Driven by the AudioContext's own clock when a decoded buffer is playing —
// when the context is suspended (pause), currentTime simply stops advancing,
// so notes, the song, and the visuals all freeze/resume in lockstep
// automatically. The <audio>-element fallback mode uses performance.now()
// instead, since suspending the context doesn't pause a media element.
function songTimeNow() {
  if (state.audioMode === 'element') {
    if (state.phase === 'paused') return state.mediaPausedAt;
    return (performance.now() - state.mediaGameStartPerf) / 1000;
  }
  return audioCtx.currentTime - state.gameStartCtxTime;
}

// ---------------- Input handling ----------------
const keyLaneMap = {};
for (const lane of ['left', 'right']) {
  for (const code of KEY_BINDINGS[lane]) keyLaneMap[code] = lane;
}
const heldKeys = new Set();

window.addEventListener('keydown', (e) => {
  if (state.phase === 'menu') return;
  if (e.code === 'KeyR') { handleRestartKeyDown(); }
  if (e.code === 'Escape') { if (!e.repeat) togglePause(); return; }
  const lane = keyLaneMap[e.code];
  if (!lane) return;
  e.preventDefault();
  if (heldKeys.has(e.code)) return; // ignore OS auto-repeat
  heldKeys.add(e.code);
  laneCountChange(lane, +1);
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'KeyR') handleRestartKeyUp();
  const lane = keyLaneMap[e.code];
  if (lane && heldKeys.has(e.code)) {
    heldKeys.delete(e.code);
    laneCountChange(lane, -1);
  }
});

function laneCountChange(lane, delta) {
  const key = lane + 'Count';
  state[key] = Math.max(0, state[key] + delta);
  const wasHeld = state[lane + 'Held'];
  const nowHeld = state[key] > 0;
  state[lane + 'Held'] = nowHeld;
  if (state.phase !== 'perform') return;
  if (!wasHeld && nowHeld) onLaneJustPressed(lane);
  if (wasHeld && !nowHeld) onLaneJustReleased(lane);
}

// Touch controls
const touchLeft = document.getElementById('touch-left');
const touchRight = document.getElementById('touch-right');
function bindTouchButton(el, lane) {
  const activePointers = new Set();
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    if (activePointers.has(e.pointerId)) return;
    activePointers.add(e.pointerId);
    el.classList.add('pressed');
    laneCountChange(lane, +1);
  });
  function release(e) {
    e.preventDefault();
    if (!activePointers.has(e.pointerId)) return;
    activePointers.delete(e.pointerId);
    if (activePointers.size === 0) el.classList.remove('pressed');
    laneCountChange(lane, -1);
  }
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('pointerleave', release);
  // Rapid taps get misread by iOS/Android as a "double-tap to zoom" gesture;
  // touch-action alone doesn't always suppress it in time, so also block the
  // gesture events directly.
  el.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  el.addEventListener('dblclick', (e) => e.preventDefault());
}
bindTouchButton(touchLeft, 'left');
bindTouchButton(touchRight, 'right');
document.addEventListener('gesturestart', (e) => e.preventDefault()); // iOS Safari pinch-zoom gesture

// Safety net: if a zoom slips through anyway (some Android WebViews ignore
// user-scalable=no), force it back by re-applying the viewport meta tag.
const viewportMeta = document.querySelector('meta[name="viewport"]');
function resetZoom() {
  if (!viewportMeta) return;
  const content = viewportMeta.getAttribute('content');
  viewportMeta.setAttribute('content', content + ',user-scalable=no');
  viewportMeta.setAttribute('content', content);
}
document.addEventListener('gestureend', resetZoom);
window.visualViewport?.addEventListener('resize', () => {
  if (window.visualViewport.scale > 1.01) resetZoom();
});

function onLaneJustPressed(lane) {
  playSfx(lane);
  state.hitFx[lane] = { state: 'hit', frame: 0, startTime: songTimeNow() };
  state.kris.anim = lane === 'left' ? 'low_note_down' : 'high_note_down';
  hitLane(lane);
}
function onLaneJustReleased(lane) {
  state.hitFx[lane] = { state: 'idle' };
  state.kris.anim = lane === 'left' ? 'low_note_up' : 'high_note_up';
  state.kris.until = songTimeNow() + 0.15;
}

// ---------------- Restart hold ----------------
const restartBtn = document.getElementById('restart-btn');
const restartRing = document.getElementById('restart-ring');
const RESTART_HOLD_TIME = 1.25;
let restartHolding = false, restartStart = 0, restartTriggered = false;

function handleRestartKeyDown() {
  if (!restartHolding) { restartHolding = true; restartStart = performance.now(); restartTriggered = false; }
}
function handleRestartKeyUp() {
  restartHolding = false;
  restartRing.style.strokeDashoffset = 113;
}
restartBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  restartHolding = true; restartStart = performance.now(); restartTriggered = false;
});
restartBtn.addEventListener('pointerup', handleRestartKeyUp);
restartBtn.addEventListener('pointerleave', handleRestartKeyUp);

function updateRestartHold() {
  if (!restartHolding || restartTriggered) return;
  const elapsed = (performance.now() - restartStart) / 1000;
  const progress = Math.min(1, elapsed / RESTART_HOLD_TIME);
  restartRing.style.strokeDashoffset = String(113 * (1 - progress));
  if (progress >= 1) {
    restartTriggered = true;
    restartSong();
  }
}

function restartSong() {
  resetChartState();
  if (state.audioMode === 'element') {
    if (state.mediaEl) { state.mediaEl.pause(); state.mediaEl.currentTime = 0; }
    state.mediaStarted = false;
    state.mediaGameStartPerf = performance.now();
  } else {
    state.gameStartCtxTime = audioCtx.currentTime;
    scheduleSongPlayback(state.gameStartCtxTime + AUDIO_START_DELAY, 0);
  }
  state.phase = 'perform';
  updateScoreDisplay();
  pauseOverlay.classList.add('hidden');
  endOverlay.classList.add('hidden');
}

// ---------------- Pause ----------------
document.getElementById('pause-btn').addEventListener('click', togglePause);
document.getElementById('resume-btn').addEventListener('click', togglePause);
document.getElementById('menu-btn').addEventListener('click', quitToMenu);
document.getElementById('quit-btn').addEventListener('click', quitToMenu);
document.getElementById('replay-btn').addEventListener('click', restartSong);
document.getElementById('end-menu-btn').addEventListener('click', quitToMenu);

function togglePause() {
  if (state.phase === 'perform') {
    state.phase = 'paused';
    if (state.audioMode === 'element') {
      state.mediaPausedAt = songTimeNow();
      if (state.mediaEl) state.mediaEl.pause();
    } else {
      audioCtx.suspend().catch(() => {});
    }
    pauseOverlay.classList.remove('hidden');
  } else if (state.phase === 'paused') {
    state.phase = 'perform';
    pauseOverlay.classList.add('hidden');
    if (state.audioMode === 'element') {
      state.mediaGameStartPerf = performance.now() - state.mediaPausedAt * 1000;
      if (state.mediaEl && state.mediaStarted) state.mediaEl.play().catch(() => {});
    } else {
      audioCtx.resume().catch(() => {});
    }
  }
}

// ---------------- Gameplay logic ----------------
function hitLane(lane) {
  const t = songTimeNow();
  // 1) tap notes take priority (single instantaneous hit)
  let best = null, bestIdx = -1, bestIsHold = false;
  for (let i = 0; i < state.activeNotes.length; i++) {
    const n = state.activeNotes[i];
    if (n.lane !== lane || n.hit || n.missed || n.isHold) continue;
    const diff = Math.abs(t - n.targetTime);
    if (diff <= GOOD_WINDOW) {
      if (best === null || diff < Math.abs(t - best.targetTime)) { best = n; bestIdx = i; }
    }
  }
  if (best) {
    const diff = Math.abs(t - best.targetTime);
    const judgment = diff <= PERFECT_WINDOW ? 'perfect' : 'good';
    judgeHit(lane, judgment, best);
    return;
  }
  // no tap note in range — nothing happens (matches original: pressing does nothing if no note nearby)
}

function judgeHit(lane, judgment, note) {
  note.hit = true;
  const points = judgment === 'perfect' ? PERFECT_SCORE : GOOD_SCORE;
  state.score += points;
  state.combo += 1;
  updateScoreDisplay();
  state.hitFx[lane] = { state: judgment, frame: 0, startTime: songTimeNow() };
  showJudgePop(lane, judgment);
}

function showJudgePop(lane, judgment) {
  const colors = { perfect: '#21f17b', good: '#75e0ff', miss: '#ff5c7a' };
  const text = judgment === 'perfect' ? 'PERFECT!' : judgment === 'good' ? 'GOOD' : 'MISS';
  state.judgePop = { text, color: colors[judgment], x: LANE_X[lane], y: HIT_Y - 40, startTime: songTimeNow() };
}

function updateScoreDisplay() {
  // drawn directly on canvas each frame; nothing to do here except keep for hooks
}

// ---------------- Note spawning & simulation ----------------
function spawnNotes() {
  const t = songTimeNow();
  const chart = state.chart;
  // chart.taps[].time is measured relative to the start of the song audio
  // (tick 0 in the MIDI == the first sample of the mp3). The audio itself
  // doesn't start playing until songTimeNow() reaches AUDIO_START_DELAY, so
  // the note must reach the hit line at AUDIO_START_DELAY + tap.time to line
  // up with what's actually playing, and must spawn AUDIO_DELAY seconds
  // before that so it has time to fall.
  while (state.tapIndex < chart.taps.length && chart.taps[state.tapIndex].time + AUDIO_START_DELAY - AUDIO_DELAY <= t) {
    const tap = chart.taps[state.tapIndex++];
    const targetTime = tap.time + AUDIO_START_DELAY;
    state.activeNotes.push({ lane: tap.lane, isHold: false, targetTime, spawnTime: targetTime - AUDIO_DELAY, hit: false, missed: false });
  }
  while (state.holdIndex < chart.holdPieces.length && chart.holdPieces[state.holdIndex].time + AUDIO_START_DELAY - AUDIO_DELAY <= t) {
    const piece = chart.holdPieces[state.holdIndex++];
    const targetTime = piece.time + AUDIO_START_DELAY;
    state.activeNotes.push({
      lane: piece.lane, isHold: true, holdId: piece.holdId, targetTime,
      holdStartTime: piece.holdStart + AUDIO_START_DELAY,
      holdEndTime: piece.holdEnd + AUDIO_START_DELAY,
      spawnTime: targetTime - AUDIO_DELAY, hit: false, missed: false,
    });
  }
}

function updateNotes(dt) {
  const t = songTimeNow();
  for (const n of state.activeNotes) {
    if (n.hit || n.missed) continue;
    if (n.isHold) {
      // auto-hit hold pieces while the matching lane is held, within a generous window
      if (Math.abs(t - n.targetTime) <= GOOD_WINDOW && state[n.lane + 'Held']) {
        n.hit = true;
        state.score += HOLD_SCORE_PER_SECOND * HOLD_SCORE_INTERVAL;
        state.hitFx[n.lane] = { state: 'perfect', frame: 0, startTime: t };
        updateScoreDisplay();
        continue;
      }
    }
    if (t > n.targetTime + GOOD_WINDOW) {
      n.missed = true;
      if (!n.isHold) {
        state.combo = 0;
        showJudgePop(n.lane, 'miss');
        state.hitFx[n.lane] = { state: 'miss', frame: 0, startTime: t };
      }
    }
  }
  // Garbage collect every frame (not just once the array balloons past some
  // threshold) so hit/missed notes don't pile up and slow down the per-frame
  // update loop, hitLane()'s scan, and rendering during dense/rolled runs.
  state.activeNotes = state.activeNotes.filter(n => !(n.hit || n.missed) || (t - n.targetTime) < 1.0);
}

function noteY(note) {
  const t = songTimeNow();
  return SPAWN_Y + (t - note.spawnTime) * FALL_RATE;
}

// ---------------- Rendering ----------------
const gameStageEl = document.getElementById('game-stage');
function resizeCanvas() {
  const availW = gameStageEl.clientWidth, availH = gameStageEl.clientHeight;
  if (!availW || !availH) return;
  const scale = Math.min(availW / CANVAS_W, availH / CANVAS_H);
  canvas.style.width = Math.floor(CANVAS_W * scale) + 'px';
  canvas.style.height = Math.floor(CANVAS_H * scale) + 'px';
}
window.addEventListener('resize', resizeCanvas);
window.addEventListener('orientationchange', () => setTimeout(resizeCanvas, 200));

function drawSprite(name, x, y, w, h) {
  const img = IMG[name];
  if (!img) return;
  ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function drawFrame(img, x, y, w, h) {
  if (!img) return;
  ctx.drawImage(img, Math.round(x), Math.round(y), Math.round(w), Math.round(h));
}

function render() {
  ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
  // Background
  drawFrame(IMG['bg_frame1'], 0, 0, CANVAS_W, CANVAS_H);

  // Characters (bottom row, simple bob animation)
  const t = songTimeNow();
  const bob = Math.sin(t * 3) * 2;
  drawCharacter('susie', 160, 400 + bob, 1.7);
  drawCharacter('ralsei', 480, 400 + Math.sin(t * 3 + 1) * 2, 2.6);
  drawKris(320, 404);

  // Board backdrop
  drawFrame(IMG['rhythmboard_frame0'], BOARD_RECT.x, BOARD_RECT.y, BOARD_RECT.w, BOARD_RECT.h);

  // Falling notes, clipped to the board
  ctx.save();
  ctx.beginPath();
  ctx.rect(BOARD_RECT.x, BOARD_RECT.y, BOARD_RECT.w, BOARD_RECT.h);
  ctx.clip();

  // Sustained holds are grouped by holdId and drawn as one continuous bar
  // spanning their real start/end time (not sampled from whichever discrete
  // pieces happen to still be unresolved), so they always read as a single
  // solid connected note — never a row of separated dashes/crosses.
  const holdGroups = new Map();
  for (const n of state.activeNotes) {
    if (n.hit || n.missed) continue;
    if (n.isHold) {
      if (!holdGroups.has(n.holdId)) {
        holdGroups.set(n.holdId, { lane: n.lane, startTime: n.holdStartTime, endTime: n.holdEndTime });
      }
    } else {
      const y = noteY(n);
      if (y < SPAWN_Y - 20 || y > DESPAWN_Y) continue;
      drawNote(n, y);
    }
  }
  for (const g of holdGroups.values()) drawHoldBar(g, t);

  ctx.restore();

  // Decorative frame overlay on top
  drawFrame(IMG['rhythmboard_frame1'], BOARD_RECT.x, BOARD_RECT.y, BOARD_RECT.w, BOARD_RECT.h);

  // Hit indicators
  drawHitIndicator('left');
  drawHitIndicator('right');

  // Hit FX bursts
  drawHitFx('left');
  drawHitFx('right');

  // Judgment popup
  drawJudgePop();

  // HUD
  drawScoreHud();
}

function drawCharacter(prefix, cx, cy, scale) {
  const img = IMG[prefix + '_idle'];
  if (!img) return;
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, Math.round(cx - w / 2), Math.round(cy - h), Math.round(w), Math.round(h));
}

function drawKris(cx, cy) {
  const now = songTimeNow();
  let anim = state.kris.anim;
  if (state.kris.until && now > state.kris.until && (anim === 'low_note_up' || anim === 'high_note_up')) {
    anim = 'idle';
    state.kris.anim = 'idle';
  }
  const img = IMG['kris_' + anim] || IMG['kris_idle'];
  if (!img) return;
  const scale = 2.4;
  const w = img.width * scale, h = img.height * scale;
  ctx.drawImage(img, Math.round(cx - w / 2), Math.round(cy - h), Math.round(w), Math.round(h));
}

function drawNote(n, y) {
  let frameIdx = n.lane === 'left' ? NOTE_FRAME.left : NOTE_FRAME.right;
  const img = IMG['note_frame' + frameIdx];
  if (!img) return;
  const wScale = 3.6, hScale = 3.6;
  const w = img.width * wScale, h = img.height * hScale;
  const x = LANE_X[n.lane];
  ctx.drawImage(img, Math.round(x - w / 2), Math.round(y - h / 2), Math.round(w), Math.round(h));
}

// Draws a whole sustained hold (grouped by holdId) as a single continuous,
// solid rounded bar spanning its real start/end time. The tiny "+"-shaped
// note sprite was never meant to be stretched into a long bar — doing so
// (or drawing a chain of them) produced a deformed/gapped look, so instead
// this fills a plain colored rounded rect, which reads cleanly at any length.
const HOLD_COLOR = { left: '#21f17b', right: '#75edff' };
function drawHoldBar(g, t) {
  const barW = 32;
  const x = LANE_X[g.lane];
  // The bar's bottom (already-played) edge pins at the hit line once the
  // hold's leading edge arrives there; its top (not-yet-played) edge keeps
  // falling until the hold's end time also arrives.
  const yAtStart = HIT_Y - (g.startTime - t) * FALL_RATE;
  const yAtEnd = HIT_Y - (g.endTime - t) * FALL_RATE;
  const bottom = Math.min(yAtStart, HIT_Y);
  const top = Math.min(yAtEnd, bottom - 6);
  if (bottom < SPAWN_Y - 20 || top > DESPAWN_Y) return;
  const r = barW / 2;
  ctx.save();
  ctx.fillStyle = HOLD_COLOR[g.lane] || '#ffffff';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x - barW / 2, top, barW, bottom - top, r); else ctx.rect(x - barW / 2, top, barW, bottom - top);
  ctx.fill();
  // Subtle highlight stripe down the middle for a bit of depth/polish.
  ctx.globalAlpha = 0.3;
  ctx.fillStyle = '#ffffff';
  const stripeH = Math.max(0, bottom - top - 8);
  ctx.beginPath();
  if (stripeH > 0) {
    if (ctx.roundRect) ctx.roundRect(x - 4, top + 4, 8, stripeH, 3); else ctx.rect(x - 4, top + 4, 8, stripeH);
    ctx.fill();
  }
  ctx.restore();
}

function drawHitIndicator(lane) {
  const fx = state.hitFx[lane];
  const hit = fx && (fx.state === 'hit' || fx.state === 'perfect' || fx.state === 'good') && songTimeNow() - fx.startTime < 0.12;
  const frameIdx = lane === 'left' ? (hit ? 13 : 12) : (hit ? 4 : 3);
  const img = IMG['note_frame' + frameIdx];
  if (!img) return;
  const scale = 4.5;
  const w = img.width * scale, h = img.height * scale;
  const x = LANE_X[lane];
  ctx.drawImage(img, Math.round(x - w / 2), Math.round(HIT_Y - h / 2), Math.round(w), Math.round(h));
}

function drawHitFx(lane) {
  const fx = state.hitFx[lane];
  if (!fx || fx.state === 'idle' || fx.state === 'hit') return;
  const elapsed = songTimeNow() - fx.startTime;
  const frame = Math.min(4, Math.floor(elapsed * 20));
  if (frame > 4 || elapsed > 0.3) { return; }
  const anim = fx.state === 'perfect' ? 'perfect' : fx.state === 'good' ? 'almost' : 'miss';
  const img = IMG[`hitfx_${anim}_${frame}`];
  if (!img) return;
  const scale = 4;
  const w = img.width * scale, h = img.height * scale;
  const x = LANE_X[lane];
  ctx.drawImage(img, Math.round(x - w / 2), Math.round(HIT_Y - h / 2 - 12), Math.round(w), Math.round(h));
}

function drawJudgePop() {
  const pop = state.judgePop;
  if (!pop) return;
  const elapsed = songTimeNow() - pop.startTime;
  if (elapsed > 0.6) { state.judgePop = null; return; }
  const alpha = 1 - elapsed / 0.6;
  const y = pop.y - elapsed * 30;
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.font = 'bold 16px Deltarune, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = pop.color;
  ctx.fillText(pop.text, pop.x, y);
  ctx.restore();
}

function drawScoreHud() {
  ctx.save();
  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.font = '20px Deltarune, sans-serif';
  ctx.fillText('SCORE ' + Math.floor(state.score), CANVAS_W - 20, 40);
  if (state.combo > 1) {
    ctx.font = '13px Deltarune, sans-serif';
    ctx.fillStyle = '#a89ecb';
    ctx.fillText(state.combo + ' combo', CANVAS_W - 20, 58);
  }
  if (state.songMeta) {
    ctx.textAlign = 'left';
    ctx.font = '13px Deltarune, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    const label = state.songMeta.difficulty ? `${state.songMeta.title}  \u00b7  ${state.songMeta.difficulty}` : state.songMeta.title;
    ctx.fillText(label, 20, 30);
  }
  ctx.restore();
}

// ---------------- Main loop ----------------
let lastTime = performance.now();
function loop(now) {
  if (state.phase === 'menu') return; // don't keep drawing the hidden game canvas while on the menu

  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;

  if (state.phase === 'perform') {
    const t = songTimeNow();
    if (state.audioMode === 'element' && !state.mediaStarted && t >= AUDIO_START_DELAY) {
      state.mediaStarted = true;
      if (state.mediaEl) state.mediaEl.play().catch(() => {});
    }
    spawnNotes();
    updateNotes(dt);
    updateRestartHold();
    checkSongEnd(t);
  }

  render();
  requestAnimationFrame(loop);
}

function checkSongEnd(t) {
  const chart = state.chart;
  if (!chart) return;
  const allSpawned = state.tapIndex >= chart.taps.length && state.holdIndex >= chart.holdPieces.length;
  const noneActive = state.activeNotes.every(n => n.hit || n.missed);
  if (allSpawned && noneActive && t > chart.duration + AUDIO_START_DELAY + 1.0) {
    endSong();
  }
}

function endSong() {
  state.phase = 'ended';
  stopAllAudio();
  finalScoreEl.textContent = 'SCORE ' + Math.floor(state.score);
  endOverlay.classList.remove('hidden');
}

// ---------------- Boot ----------------
(async function init() {
  buildSongList();
  await Promise.all([preloadSprites(), preloadSfx()]);
  try { await document.fonts.load('20px Deltarune'); } catch (e) {}
  requestAnimationFrame(loop);
})();
