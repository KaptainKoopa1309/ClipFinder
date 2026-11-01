// Runs the scan and the cutting off the page's main thread. Messages in: scan, cut, stop.
import { loadProfile, CounterReader } from './hud.js';
import { openVideo, calibrate, scan, readMatchEnd, cutClip, calibrateLive, scanLive, decodeFailed } from './video.js';
import { analyse, analyseLive, spliceMatchEnd } from './detect.js';
import { loadLiveProfile, learnName, followFeed, deathTimes, liveRanges, counterKills, counterReadable, fuseKills, popupEvents } from './live.js';

let current = null;
let stopRequested = false;

const send = (type, data = {}, transfer = []) => postMessage({ type, ...data }, transfer);
const log = (text) => send('log', { text });
const seconds = (ms) => Math.round(ms) / 1000;

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'scan') await scanOrRetry(data);
    else if (data.type === 'cut') await runCut(data);
    else if (data.type === 'stop') stopRequested = true;
  } catch (error) {
    send('error', { message: error.message || String(error), stack: error.stack });
  }
};

/** runScan, once more with the software decoder if the browser's (usually hardware) decoder fails. */
async function scanOrRetry(data) {
  try {
    await runScan(data);
  } catch (error) {
    if (data.software || stopRequested || !decodeFailed(error)) throw error;
    log(`The video decoder failed (${error.message}); starting again with the software decoder (slower).`);
    await runScan({ ...data, software: true });
  }
}

async function runScan({ file, interval, rules, capture = 'auto', format = 'auto', parts = null, software = false }) {
  stopRequested = false;
  const timings = {};
  let mark = performance.now();
  const lap = (name) => { const now = performance.now(); timings[name] = seconds(now - mark); mark = now; };

  const { profile, digits, combo } = await loadProfile(new URL('../', import.meta.url));
  const reader = new CounterReader(profile, digits);
  const v = await openVideo(file);
  v.software = software;
  v.comboBytes = combo;
  current = v;
  lap('open');
  send('info', { info: v.info });
  if (!v.info.canDecode) {
    throw new Error(`This browser cannot decode the video codec (${v.info.codecString || v.info.codec}).`);
  }
  if (v.info.rotation) log(`The video is stored rotated ${v.info.rotation} degrees; frames are turned upright before reading.`);

  send('phase', { phase: 'calibrating' });
  let hud = null;
  if (format !== 'live') {
    try {
      hud = await calibrate(v, reader, profile, log, capture);
    } catch (error) {
      // Replay recordings always show the spectator kill counter; live recordings never do.
      if (format !== 'auto' || !/kill counter/.test(error.message)) throw error;
      log('No spectator kill counter: reading it as a live recording.');
    }
  }
  if (!hud) return runLive(v, rules, capture, timings, lap, file, parts, software);
  lap('calibrate');

  send('phase', { phase: 'scanning' });
  const result = await scan(v, hud, reader, profile, interval, {
    onProgress: (p) => send('progress', { ...p, duration: v.info.duration }),
    shouldStop: () => stopRequested,
    mode: capture,
  });
  lap('scan');
  if (stopRequested) log(`Stopped at ${result.duration.toFixed(1)} s; results cover the part scanned.`);

  send('phase', { phase: 'match end' });
  const matchEnd = await readMatchEnd(v, result, reader, profile, interval);
  spliceMatchEnd(result, matchEnd.final, matchEnd.switchTime);
  lap('matchEnd');
  if (matchEnd.final.length) {
    log(`End of match: read ${matchEnd.final.length} replay-panel counts (final count ${matchEnd.final[matchEnd.final.length - 1].count}).`);
  }

  const analysis = analyse(result, rules, matchEnd);
  lap('analyse');
  const { nameReference, ...hudInfo } = hud;
  send('done', {
    info: v.info, hud: hudInfo, timings, stopped: stopRequested,
    scan: {
      duration: result.duration, decoded: result.decoded, readTime: result.readTime,
      scanTime: result.scanTime, capture: result.capture, captureTime: result.captureTime, readings: result.readings, respawn_checks: result.respawn_checks,
    },
    analysis: {
      events: analysis.events, warnings: analysis.warnings.length, excluded: analysis.excluded,
      clips: analysis.clips, ranking: analysis.ranking,
    },
  });
}

/** Parts read at once: 1 on phones and small machines, 2 from 4 cores, 4 from 8. */
function poolSize() {
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const cores = navigator.hardwareConcurrency || 2;
  if (mobile || typeof Worker === 'undefined') return 1;
  return cores >= 8 ? 4 : cores >= 4 ? 2 : 1;
}

/** Workers (scan-worker.js) that each read part of the recording. */
function makePool(file, n, mode, software) {
  const workers = Array.from({ length: n }, () => new Worker(new URL('./scan-worker.js', import.meta.url), { type: 'module' }));
  const run = (worker, message, onProgress) => new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress?.(data);
      else if (data.type === 'done') resolve(data.result);
      else reject(new Error(data.message));
    };
    worker.onerror = (e) => reject(new Error(e.message || 'A scan worker failed.'));
    worker.postMessage({ ...message, file, mode, software });
  });
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  return {
    n,
    /** The killfeed search frames, in consecutive runs, one run per worker. */
    locate(times, canvas) {
      const size = Math.ceil(times.length / n);
      return Promise.all(workers.map((w, i) => {
        const part = times.slice(i * size, (i + 1) * size);
        return part.length ? run(w, { type: 'locate', times: part, canvas }) : { rowsPerFrame: [], numbersPerFrame: [], n: 0 };
      }));
    },
    /** The recording in `n` time ranges on the reading grid; onProgress(seconds read, frames decoded). */
    scan(feed, duration, interval, onProgress) {
      const bounds = Array.from({ length: n + 1 }, (_, i) => (i === n ? Infinity : Math.round(duration * i / n / interval) * interval));
      const done = new Array(n).fill(0), decoded = new Array(n).fill(0);
      return Promise.all(workers.map((w, i) => run(w, { type: 'scan', feed, start: bounds[i], end: bounds[i + 1] }, (p) => {
        done[i] = p.done; decoded[i] = p.decoded;
        onProgress(sum(done), sum(decoded));
      })));
    },
    stop() { workers.forEach((w) => w.postMessage({ type: 'stop' })); },
    close() { workers.forEach((w) => w.terminate()); },
  };
}

/** Workers (analyse-worker.js) sharing the killfeed matching after a live scan; map(indices, job) as live.js expects. */
function analysisPool(data) {
  const mobile = navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
  const n = Math.min((navigator.hardwareConcurrency || 2) - 1, mobile ? 4 : 8);
  if (n < 2 || data.samples.length < 2 * n) return null;
  const size = Math.ceil(data.samples.length / n), waiting = new Map();
  let nextId = 0;
  const workers = Array.from({ length: n }, (_, k) => {
    const worker = new Worker(new URL('./analyse-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = ({ data: reply }) => {
      const { resolve, reject } = waiting.get(reply.id);
      waiting.delete(reply.id);
      if (reply.error) reject(new Error(reply.error));
      else resolve(reply.out);
    };
    worker.onerror = (e) => waiting.forEach(({ reject }) => reject(new Error(e.message || 'An analysis worker failed.')));
    worker.postMessage({ type: 'load', shape: data.shape, offset: k * size, samples: data.samples.slice(k * size, (k + 1) * size) });
    return worker;
  });
  const run = (worker, indices, job) => new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    worker.postMessage({ type: 'work', id, indices, job });
  });
  return {
    n,
    async map(indices, job) {
      const parts = workers.map(() => []);
      for (const i of indices) parts[Math.floor(i / size)].push(i);
      const out = await Promise.all(workers.map((w, k) => (parts[k].length ? run(w, parts[k], job) : [])));
      return out.flat();
    },
    close() { workers.forEach((w) => w.terminate()); },
  };
}

/** main.scan_live_video + finish_live: find the killfeed, scan, learn the player's name, follow it. */
async function runLive(v, rules, capture, timings, lap, file, parts, software) {
  const P = await loadLiveProfile(new URL('../', import.meta.url));
  const n = parts || poolSize(), pool = n > 1 ? makePool(file, n, capture, software) : null;
  if (pool) log(`Reading the recording in ${n} parts at once (${navigator.hardwareConcurrency} cores).`);
  try {
    const feed = await calibrateLive(v, P, log, capture, pool);
    lap('calibrate');
    send('phase', { phase: 'scanning' });
    const { scan: result, data } = pool ? await scanInParts(pool, v, feed, P) : await scanLive(v, feed, P, {
      onProgress: (p) => send('progress', { ...p, duration: v.info.duration }),
      shouldStop: () => stopRequested,
      mode: capture,
    });
    lap('scan');
    await finishLive(v, rules, timings, lap, P, feed, result, data);
  } finally {
    pool?.close();
  }
}

/** scanLive over the pool's parts, joined in time order. */
async function scanInParts(pool, v, feed, P) {
  const started = performance.now();
  const parts = await pool.scan(feed, v.info.duration, P.interval, (seconds, decoded) => {
    if (stopRequested) pool.stop();
    send('progress', { seconds, decoded, elapsed: (performance.now() - started) / 1000, duration: v.info.duration });
  });
  const readings = parts.flatMap((p) => p.readings), samples = parts.flatMap((p) => p.samples);
  if (!readings.length) throw new Error('No readable frames.');
  return {
    scan: {
      readings, feed, duration: Math.max(...parts.map((p) => p.duration)), interval: P.interval,
      stopped: parts.some((p) => p.stopped), decoded: parts.reduce((a, p) => a + p.decoded, 0),
      capture: parts[0].capture, scanTime: (performance.now() - started) / 1000,
    },
    data: { shape: parts.find((p) => p.shape)?.shape, samples },
  };
}

async function finishLive(v, rules, timings, lap, P, feed, result, data) {
  if (stopRequested) log(`Stopped at ${result.duration.toFixed(1)} s; results cover the part scanned.`);
  send('phase', { phase: 'following the killfeed' });
  const pool = analysisPool(data);
  let template, feedKills, feedDeaths;
  try {
    template = await learnName(data, pool?.map);
    ({ kills: feedKills, feedDeaths } = await followFeed(result, data, template, P, pool?.map));
  } finally {
    pool?.close();
  }
  lap('follow');
  const deaths = deathTimes(result.readings, feedDeaths, P);
  const counter = counterKills(result.readings, P.streaks, P), popups = popupEvents(result.readings, P).reduce((a, [, n]) => a + n, 0);
  const kills = fuseKills(result.readings, feedKills, deaths, P.streaks, P);
  log(`Kills: points counter ${counter.length} (${P.streaks.names.join(' / ')}), score popups ${popups}, killfeed ${feedKills.length}; `
    + `combined ${kills.length}${counterReadable(result.readings, P) ? '' : ' (points counter not readable)'}.`);
  const analysis = analyseLive(result, kills, deaths, liveRanges(result.readings, deaths, rules.respawn_settle, P), rules);
  lap('analyse');
  log(`Followed player's name learned from the killfeed (${template.w}x${template.h} px); `
    + `${kills.length} kills, ${deaths.length} deaths.`);
  send('done', {
    info: v.info, format: 'live', hud: { feed }, timings, stopped: stopRequested,
    scan: {
      duration: result.duration, decoded: result.decoded, scanTime: result.scanTime, capture: result.capture,
      readings: result.readings, kills, feed_kills: feedKills, feed_deaths: feedDeaths,
    },
    analysis: {
      events: analysis.events, warnings: 0, excluded: analysis.excluded, deaths,
      clips: analysis.clips, ranking: analysis.ranking,
    },
  });
}

async function runCut({ clips }) {
  if (!current) throw new Error('Scan a video first.');
  for (const clip of clips) {
    const started = performance.now();
    const cut = await cutClip(current, clip.start, clip.end);
    const bytes = cut.bytes;
    send('clip', { id: clip.id, bytes, start: cut.start, end: cut.end, ms: performance.now() - started }, [bytes]);
  }
  send('cut-done');
}
