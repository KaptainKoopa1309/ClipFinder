// Page logic: pick a recording, scan it in worker.js, show progress, then preview and save the clips.

// Every message the page shows while it runs. Edit the wording here.
const TEXT = {
  pick: 'Select Match Recording',
  unsupported: 'This browser can’t scan videos. Please use a recent Chrome or Edge.',
  starting: 'Calibrating Video',
  scanning: (pct) => `Analyzing Video ${pct}%`,
  eta: (time) => `Estimated time: ${time}`,
  finishing: 'Finalizing Clips',
  cutting: (done, total) => `Saving clips, ${done} of ${total}`,
  found: (n) => (n === 1 ? '1 clip found. Best first.' : `${n} clips found. Ordered by score.`),
  none: (kills) => `No clips found: no life in this recording had ${kills} or more kills.`,
  clipTitle: (rank, kills) => `Clip ${rank}: ${kills} kills`,
  clipInfo: (seconds, start) => `${seconds} s long, starts at ${start} in your recording`,
  download: 'Download',
  zipping: 'Downloading',
  notReplay: 'This doesn’t look like a Replay recording. Choose “In-game recording” and try again.',
  notLive: 'This doesn’t look like an in-game recording. Choose “Replay” and try again.',
  noName: 'We couldn’t find your name in the killfeed, Clearer Recording resolution or quality is required.',
  badCodec: 'This browser can’t read this video’s format. Try a different browser.',
  failed: 'This video couldn’t be read. Check it’s an MP4 match recording and try again.',
  noTimes: 'None found',
};

const $ = (id) => document.getElementById(id);
const VIEWS = ['chooseView', 'scanView', 'resultsView'];
const PHASES = { calibrating: [0, .05], scanning: [.05, .9], 'match end': [.9, .92], 'following the killfeed': [.9, .92] };
const CUTTING = [.92, 1];

// The page state, also reachable from the browser console as window.clipsFinder.
const state = { file: null, worker: null, run: null, clips: [], wakeLock: null };
window.clipsFinder = state;

const show = (view) => VIEWS.forEach((v) => { $(v).hidden = v !== view; });
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const stem = (name) => name.replace(/\.[^.]+$/, '');
const isMobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

const missing = !window.isSecureContext || !('VideoDecoder' in window) || !('OffscreenCanvas' in window);
if (missing) {
  $('supportText').textContent = TEXT.unsupported;
  $('supportText').hidden = false;
}

// --- Choosing a recording -------------------------------------------------------------------
function setFile(file) {
  if (!file) return;
  state.file = file;
  $('pickText').textContent = file.name;
  $('pick').classList.add('has-file');
  $('findBtn').disabled = missing;
}
$('fileInput').addEventListener('change', (e) => setFile(e.target.files[0]));
const pick = $('pick');
['dragenter', 'dragover'].forEach((ev) => pick.addEventListener(ev, (e) => { e.preventDefault(); pick.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => pick.addEventListener(ev, (e) => { e.preventDefault(); pick.classList.remove('over'); }));
pick.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0]));

// --- Scanning --------------------------------------------------------------------------------
const warnOnLeave = (e) => { e.preventDefault(); e.returnValue = ''; };

async function keepAwake(on) {
  try {
    if (on && !state.wakeLock) state.wakeLock = await navigator.wakeLock?.request('screen');
    else if (!on && state.wakeLock) { await state.wakeLock.release(); state.wakeLock = null; }
  } catch { state.wakeLock = null; }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.run && !state.run.finished) keepAwake(true);
});

$('findBtn').addEventListener('click', async () => {
  if (!state.file) return;
  clearClips();
  const format = document.querySelector('input[name="rtype"]:checked').value;
  const minKills = Number($('minKills').value);
  state.run = { file: state.file.name, format, minKills, phase: null, started: performance.now() };
  setProgress(0, TEXT.starting, '');
  show('scanView');
  window.addEventListener('beforeunload', warnOnLeave);
  keepAwake(true);
  try {
    const profile = await fetch('hud-profile.json').then((r) => r.json());
    const rules = { ...profile.rules, min_kills: minKills };
    // ?parts=N in the page address forces how many parts of the video are read at once (debugging).
    const parts = Number(new URLSearchParams(location.search).get('parts')) || null;
    state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    state.worker.onmessage = onWorkerMessage;
    state.worker.onerror = (e) => fail(e.message || 'Worker failed to start.');
    state.worker.postMessage({ type: 'scan', file: state.file, interval: rules.interval, rules, capture: 'auto', format, parts });
  } catch (e) {
    fail(e.message);
  }
});

$('cancelBtn').addEventListener('click', () => {
  stopWorker();
  show('chooseView');
});

function stopWorker() {
  clearInterval(creep);
  state.worker?.terminate();
  state.worker = null;
  if (state.run) state.run.finished = true;
  window.removeEventListener('beforeunload', warnOnLeave);
  keepAwake(false);
}

function setProgress(fraction, status, eta) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  $('barFill').style.width = `${pct}%`;
  $('bar').setAttribute('aria-valuenow', pct);
  $('statusText').textContent = status;
  $('etaText').textContent = eta;
}

const within = ([a, b], f) => a + (b - a) * f;

// Steps that report no progress of their own (getting ready, finishing) creep towards their end, so the bar never looks stuck.
let creep = null;
function startCreep([, end], status) {
  clearInterval(creep);
  creep = setInterval(() => {
    const now = parseFloat($('barFill').style.width) / 100 || 0;
    setProgress(now + (end - now) * .03, status, '');
  }, 500);
}

function onWorkerMessage({ data }) {
  switch (data.type) {
    case 'log': console.debug(`[scan] ${data.text}`); break;
    case 'info': state.run.info = data.info; break;
    case 'phase': {
      state.run.phase = data.phase;
      const range = PHASES[data.phase] || PHASES['match end'];
      clearInterval(creep);
      if (data.phase !== 'scanning') {
        const status = range[0] >= .9 ? TEXT.finishing : TEXT.starting;
        setProgress(range[0], status, '');
        startCreep(range, status);
      }
      break;
    }
    case 'progress': {
      const f = Math.min(1, data.seconds / data.duration), total = within(PHASES.scanning, f);
      const speed = data.seconds / Math.max(data.elapsed, .001);
      const eta = data.elapsed > 3 ? TEXT.eta(mmss((data.duration - data.seconds) / Math.max(speed, .001))) : '';
      setProgress(total, TEXT.scanning(Math.round(total * 100)), eta);
      break;
    }
    case 'done': onDone(data); break;
    case 'clip': onClip(data); break;
    case 'cut-done': finish(); break;
    case 'error': fail(data.message, data.stack); break;
    default: break;
  }
}

function fail(message, stack) {
  console.error(message, stack || '');
  stopWorker();
  let text = TEXT.failed;
  if (/kill counter/.test(message)) text = TEXT.notReplay;
  else if (/killfeed/.test(message)) text = TEXT.notLive;
  else if (/name never shows/.test(message)) text = TEXT.noName;
  else if (/decode the video codec/.test(message)) text = TEXT.badCodec;
  showResults(text);
}

// --- Clips -----------------------------------------------------------------------------------
function onDone({ analysis }) {
  state.run.analysis = analysis;
  console.debug('[scan] result', analysis);
  const ordered = analysis.ranking.map((id) => analysis.clips.find((c) => c.id === id));
  state.run.ordered = ordered;
  if (!ordered.length) {
    finish();
    return;
  }
  clearInterval(creep);
  setProgress(CUTTING[0], TEXT.cutting(0, ordered.length), '');
  state.worker.postMessage({ type: 'cut', clips: ordered.map(({ id, start, end }) => ({ id, start, end })) });
}

function clipName(rank, clip, seconds) {
  return `${String(rank).padStart(2, '0')} - ${clip.kills} kills - ${Math.round(seconds)} secs (${stem(state.run.file)}).mp4`;
}

function onClip({ id, bytes, start, end }) {
  const { ordered } = state.run, rank = ordered.findIndex((c) => c.id === id) + 1, clip = ordered[rank - 1];
  const file = new File([bytes], clipName(rank, clip, end - start), { type: 'video/mp4' });
  state.clips.push({ rank, kills: clip.kills, start, seconds: Math.round(end - start), file, url: URL.createObjectURL(file) });
  const done = state.clips.length;
  setProgress(within(CUTTING, done / ordered.length), TEXT.cutting(done, ordered.length), '');
}

function finish() {
  stopWorker();
  const { clips } = state;
  showResults(clips.length ? TEXT.found(clips.length) : TEXT.none(state.run.minKills), state.run.analysis);
}

// Kills and deaths found, with their times, so the player can check them against the scoreboard.
// Replay scans don't count deaths, so that box is hidden for them.
function showStats(analysis) {
  $('stats').hidden = !analysis;
  if (!analysis) return;
  const kills = analysis.events.flatMap((e) => Array(e.count).fill(e.time)), deaths = analysis.deaths;
  const chips = (id, times) => {
    const spans = times.map((t) => Object.assign(document.createElement('span'), { textContent: mmss(t) }));
    $(id).replaceChildren(...(spans.length ? spans : [TEXT.noTimes]));
  };
  $('killCount').textContent = kills.length;
  chips('killTimes', kills);
  $('deathBox').hidden = $('deathList').hidden = !deaths;
  if (deaths) {
    $('deathCount').textContent = deaths.length;
    chips('deathTimes', deaths);
  }
}

function showResults(message, analysis = null) {
  const list = $('clips');
  list.textContent = '';
  $('resultText').textContent = message;
  showStats(analysis);
  state.clips.sort((a, b) => a.rank - b.rank).forEach((clip) => {
    const li = document.createElement('li');
    const video = Object.assign(document.createElement('video'), {
      src: `${clip.url}#t=0.1`, controls: true, playsInline: true, preload: 'metadata',
    });
    const row = document.createElement('div');
    row.className = 'info-row';
    const text = document.createElement('div');
    text.innerHTML = `<strong>${TEXT.clipTitle(clip.rank, clip.kills)}</strong><small>${TEXT.clipInfo(clip.seconds, mmss(clip.start))}</small>`;
    const button = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: TEXT.download });
    button.addEventListener('click', () => saveFiles([clip.file]));
    row.append(text, button);
    li.append(video, row);
    list.append(li);
  });
  $('allBtn').hidden = state.clips.length < 2;
  show('resultsView');
}

function clearClips() {
  state.clips.forEach((c) => URL.revokeObjectURL(c.url));
  state.clips = [];
  $('clips').textContent = '';
}

// --- Saving ----------------------------------------------------------------------------------
// Phones get the share sheet ("Save video" puts clips in the gallery); computers download files.
async function saveFiles(files) {
  if (isMobile && navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (files.length === 1) download(files[0]);
  else download(await zipFiles(files));
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function zipFiles(files) {
  const zip = new window.JSZip();
  files.forEach((f) => zip.file(f.name, f, { compression: 'STORE' }));
  const blob = await zip.generateAsync({ type: 'blob', streamFiles: true });
  return new File([blob], `${stem(state.run.file)} clips.zip`, { type: 'application/zip' });
}

$('allBtn').addEventListener('click', async () => {
  const button = $('allBtn'), label = button.textContent;
  button.disabled = true;
  button.textContent = TEXT.zipping;
  try {
    await saveFiles(state.clips.map((c) => c.file));
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
});

$('againBtn').addEventListener('click', () => {
  clearClips();
  state.file = null;
  $('fileInput').value = '';
  $('pickText').textContent = TEXT.pick;
  $('pick').classList.remove('has-file');
  $('findBtn').disabled = true;
  show('chooseView');
});
