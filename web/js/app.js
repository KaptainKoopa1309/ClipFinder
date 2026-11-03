// Page logic: pick one or more recordings, scan each in turn in worker.js, show progress, then preview and save the clips.

// Every message the page shows while it runs. Edit the wording here.
const TEXT = {
  pick: 'Select Match Recording',
  picked: (n) => `${n} recordings selected`,
  queue: (i, n, name) => `Recording ${i} of ${n}: ${name}`,
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
  videoInfo: (clips, kills) => `${clips === 1 ? '1 clip' : `${clips} clips`}, ${kills === 1 ? '1 kill' : `${kills} kills`} found`,
  videoFailed: 'Couldn’t be scanned',
  scanned: (n, clips) => `${n} recordings scanned, ${clips === 1 ? '1 clip' : `${clips} clips`} found. Open a recording to see only its clips.`,
  overallInfo: (n, sort) => `${n === 1 ? '1 clip' : `${n} clips`}, ${SORTS[sort].label}`,
  overallClipInfo: (seconds, start, file) => `${seconds} s long, starts at ${start} in ${file}`,
};

// The overall list's orders: by score (as within one recording), most kills, or shortest clip. Ties go to the higher score.
const SORTS = {
  score: { label: 'best score first', order: (a, b) => b.score - a.score || b.kills - a.kills },
  kills: { label: 'most kills first', order: (a, b) => b.kills - a.kills || b.score - a.score },
  time: { label: 'shortest first', order: (a, b) => a.seconds - b.seconds || b.score - a.score },
};

const $ = (id) => document.getElementById(id);
const VIEWS = ['chooseView', 'scanView', 'resultsView'];
const PHASES = { calibrating: [0, .05], scanning: [.05, .9], 'match end': [.9, .92], 'following the killfeed': [.9, .92] };
const CUTTING = [.92, 1];

// The page state, also reachable from the browser console as window.clipsFinder.
// files: the recordings picked; next: the one to scan next; results: one entry per recording scanned.
const state = { files: [], next: 0, settings: null, worker: null, run: null, results: [], wakeLock: null };
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

// --- Choosing recordings ------------------------------------------------------------------
function setFiles(list) {
  const files = [...list];
  if (!files.length) return;
  state.files = files;
  $('pickText').textContent = files.length === 1 ? files[0].name : TEXT.picked(files.length);
  $('pick').classList.add('has-file');
  $('findBtn').disabled = missing;
}
$('fileInput').addEventListener('change', (e) => setFiles(e.target.files));
const pick = $('pick');
['dragenter', 'dragover'].forEach((ev) => pick.addEventListener(ev, (e) => { e.preventDefault(); pick.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => pick.addEventListener(ev, (e) => { e.preventDefault(); pick.classList.remove('over'); }));
pick.addEventListener('drop', (e) => setFiles(e.dataTransfer.files));

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

$('findBtn').addEventListener('click', () => {
  if (!state.files.length) return;
  clearResults();
  const format = document.querySelector('input[name="rtype"]:checked').value;
  state.settings = { format, minKills: Number($('minKills').value) };
  state.next = 0;
  show('scanView');
  window.addEventListener('beforeunload', warnOnLeave);
  keepAwake(true);
  scanNext();
});

// Recordings are scanned one at a time: one scan already uses every core, so two at once would be no quicker.
async function scanNext() {
  if (state.next >= state.files.length) {
    endQueue();
    showResults();
    return;
  }
  const file = state.files[state.next++], { format, minKills } = state.settings;
  state.run = { file: file.name, format, minKills, phase: null, clips: [], started: performance.now() };
  $('queueText').hidden = state.files.length < 2;
  $('queueText').textContent = TEXT.queue(state.next, state.files.length, file.name);
  setProgress(0, TEXT.starting, '');
  try {
    const profile = await fetch('hud-profile.json').then((r) => r.json());
    const rules = { ...profile.rules, min_kills: minKills };
    // ?parts=N in the page address forces how many parts of the video are read at once (debugging).
    const parts = Number(new URLSearchParams(location.search).get('parts')) || null;
    state.worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
    state.worker.onmessage = onWorkerMessage;
    state.worker.onerror = (e) => fail(e.message || 'Worker failed to start.');
    state.worker.postMessage({ type: 'scan', file, interval: rules.interval, rules, capture: 'auto', format, parts });
  } catch (e) {
    fail(e.message);
  }
}

// Cancel stops the scan; recordings already finished still show their clips.
$('cancelBtn').addEventListener('click', () => {
  stopWorker();
  state.run?.clips.forEach((c) => URL.revokeObjectURL(c.url));
  endQueue();
  if (state.results.length) showResults();
  else show('chooseView');
});

function stopWorker() {
  clearInterval(creep);
  state.worker?.terminate();
  state.worker = null;
}

function endQueue() {
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
  // One recording failing doesn't stop the others.
  state.run.clips.forEach((c) => URL.revokeObjectURL(c.url));
  state.results.push({ file: state.run.file, message: text, analysis: null, clips: [], failed: true });
  scanNext();
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
  state.run.clips.push({ rank, kills: clip.kills, score: clip.score, start, seconds: Math.round(end - start),
    recording: state.run.file, file, url: URL.createObjectURL(file) });
  const done = state.run.clips.length;
  setProgress(within(CUTTING, done / ordered.length), TEXT.cutting(done, ordered.length), '');
}

function finish() {
  stopWorker();
  const { file, clips, minKills, analysis } = state.run;
  clips.sort((a, b) => a.rank - b.rank);
  state.results.push({ file, message: clips.length ? TEXT.found(clips.length) : TEXT.none(minKills), analysis, clips });
  scanNext();
}

const killTimes = (analysis) => analysis.events.flatMap((e) => Array(e.count).fill(e.time));

// Kills and deaths found, with their times, so the player can check them against the scoreboard.
// Replay scans don't count deaths, so that box is hidden for them.
function showStats(box, analysis) {
  const part = (cls) => box.querySelector(`.${cls}`);
  part('stats').hidden = !analysis;
  if (!analysis) return;
  const kills = killTimes(analysis), deaths = analysis.deaths;
  const chips = (cls, times) => {
    const spans = times.map((t) => Object.assign(document.createElement('span'), { textContent: mmss(t) }));
    part(cls).replaceChildren(...(spans.length ? spans : [TEXT.noTimes]));
  };
  part('kill-count').textContent = kills.length;
  chips('kill-times', kills);
  part('death-box').hidden = part('death-list').hidden = !deaths;
  if (deaths) {
    part('death-count').textContent = deaths.length;
    chips('death-times', deaths);
  }
}

// A clip with its preview and download button. In the overall list it's numbered by its place there
// and names its recording.
function clipItem(clip, place = null) {
  const li = document.createElement('li');
  const video = Object.assign(document.createElement('video'), {
    src: `${clip.url}#t=0.1`, controls: true, playsInline: true, preload: 'metadata',
  });
  const row = document.createElement('div');
  row.className = 'info-row';
  const text = document.createElement('div');
  const title = Object.assign(document.createElement('strong'), { textContent: TEXT.clipTitle(place ?? clip.rank, clip.kills) });
  const info = Object.assign(document.createElement('small'), {
    textContent: place ? TEXT.overallClipInfo(clip.seconds, mmss(clip.start), clip.recording) : TEXT.clipInfo(clip.seconds, mmss(clip.start)),
  });
  text.append(title, info);
  const button = Object.assign(document.createElement('button'), { className: 'btn', type: 'button', textContent: TEXT.download });
  button.addEventListener('click', () => saveFiles([clip.file]));
  row.append(text, button);
  li.append(video, row);
  return li;
}

// Each recording gets a section that opens and closes. A single recording's section starts open.
function videoSection(result, open) {
  const box = $('videoTemplate').content.firstElementChild.cloneNode(true);
  const part = (cls) => box.querySelector(`.${cls}`);
  box.open = open;
  part('video-name').textContent = result.file;
  part('video-info').textContent = result.failed ? TEXT.videoFailed
    : TEXT.videoInfo(result.clips.length, result.analysis ? killTimes(result.analysis).length : 0);
  part('message').textContent = result.message;
  showStats(box, result.analysis);
  if (result.clips.length) part('clips').append(...result.clips.map(clipItem));
  else part('clips').remove();
  const all = part('video-all');
  all.parentElement.hidden = result.clips.length < 2;
  all.addEventListener('click', () => saveAll(all, result.clips, `${stem(result.file)} clips.zip`));
  return box;
}

function showResults() {
  const { results } = state, clips = results.flatMap((r) => r.clips);
  $('resultText').hidden = results.length < 2;
  $('resultText').textContent = TEXT.scanned(results.length, clips.length);
  $('videos').replaceChildren(...results.map((r) => videoSection(r, results.length === 1)));
  $('overall').hidden = results.length < 2 || !clips.length;
  showOverall();
  // The bottom button saves every recording's clips; with one recording, its own button does that.
  $('allBtn').hidden = results.length < 2 || clips.length < 2;
  show('resultsView');
}

// Every recording's clips in one list, in the order picked in "Sort by".
function showOverall() {
  if ($('overall').hidden) return;
  const sort = $('sortBy').value, clips = state.results.flatMap((r) => r.clips).sort(SORTS[sort].order);
  $('overallInfo').textContent = TEXT.overallInfo(clips.length, sort);
  $('overallClips').replaceChildren(...clips.map((c, i) => clipItem(c, i + 1)));
}
$('sortBy').addEventListener('change', showOverall);

function clearResults() {
  state.results.forEach((r) => r.clips.forEach((c) => URL.revokeObjectURL(c.url)));
  state.results = [];
  $('videos').textContent = '';
  $('overallClips').textContent = '';
}

// --- Saving ----------------------------------------------------------------------------------
// Phones get the share sheet ("Save video" puts clips in the gallery); computers download files.
async function saveFiles(files, zipName) {
  if (isMobile && navigator.canShare?.({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  if (files.length === 1) download(files[0]);
  else download(await zipFiles(files, zipName));
}

function download(file) {
  const url = URL.createObjectURL(file);
  const a = Object.assign(document.createElement('a'), { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function zipFiles(files, name) {
  const zip = new window.JSZip();
  files.forEach((f) => zip.file(f.name, f, { compression: 'STORE' }));
  const blob = await zip.generateAsync({ type: 'blob', streamFiles: true });
  return new File([blob], name, { type: 'application/zip' });
}

async function saveAll(button, clips, zipName) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = TEXT.zipping;
  try {
    await saveFiles(clips.map((c) => c.file), zipName);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('allBtn').addEventListener('click', () => saveAll($('allBtn'), state.results.flatMap((r) => r.clips), 'ClipFinder clips.zip'));

$('againBtn').addEventListener('click', () => {
  clearResults();
  state.files = [];
  $('fileInput').value = '';
  $('pickText').textContent = TEXT.pick;
  $('pick').classList.remove('has-file');
  $('findBtn').disabled = true;
  show('chooseView');
});
