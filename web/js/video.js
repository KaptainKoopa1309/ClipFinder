// Reading the recording (Mediabunny + WebCodecs), cropping HUD regions from decoded frames, the
// calibration and scan passes, and cutting clips by copying the original packets.
import {
  Input, BlobSource, ALL_FORMATS, VideoSampleSink, EncodedPacketSink,
  Output, Mp4OutputFormat, BufferTarget, EncodedVideoPacketSource, EncodedAudioPacketSource,
} from '../vendor/mediabunny.min.js';
import { cropRect, linspace, round } from './cv.js';
import {
  locateCounter, locateHpBar, locateComboShift, calibrationRegions, scanRegions, readHud,
} from './hud.js';
import { matchEndPlan } from './detect.js';
import { textLines, feedRows, locateKillfeed, liveRegions, readLive, contentRect, canvasFor, unstretch, HEIGHT, Stillness, counterCandidates, counterBox } from './live.js';

/** A decoder for `v`'s frames: the browser's choice, or software when `v.software`. */
export function sampleSink(v) {
  return new VideoSampleSink(v.video, v.software ? { hardwareAcceleration: 'prefer-software' } : {});
}

/** Whether `error` came from the video decoder (worth one more try with the software decoder). */
export function decodeFailed(error) {
  return error?.name === 'EncodingError' || /decod|codec|No readable frames/i.test(error?.message || '');
}

/** The video track only (for workers that scan part of a recording). */
export async function openTrack(file, software = false) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('No video track in this file.');
  return { input, video, software, t0: await video.getFirstTimestamp() };
}

export async function openVideo(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  if (!video) throw new Error('No video track in this file.');
  const audio = await input.getPrimaryAudioTrack();
  const t0 = await video.getFirstTimestamp();
  const info = {
    container: (await input.getFormat()).name,
    codec: await video.getCodec(),
    codecString: await video.getCodecParameterString(),
    canDecode: await video.canDecode(),
    width: await video.getDisplayWidth(),
    height: await video.getDisplayHeight(),
    rotation: await video.getRotation(),
    duration: (await video.computeDuration()) - t0,
    audio: audio ? { codec: await audio.getCodec(), canCopy: true } : null,
  };
  const stats = await video.computePacketStats();
  info.frameRate = round(stats.averagePacketRate, 2);
  info.bitrate = Math.round(stats.averageBitrate / 1000);
  Object.assign(info, await keyframeStats(video, info.duration, t0));
  return { input, video, audio, t0, info };
}

/** Keyframe spacing, from the container's index (no decoding). */
async function keyframeStats(track, duration, t0) {
  const sink = new EncodedPacketSink(track);
  const times = [];
  let packet = await sink.getFirstKeyPacket({ metadataOnly: true });
  while (packet) {
    times.push(packet.timestamp - t0);
    packet = await sink.getNextKeyPacket(packet, { metadataOnly: true });
  }
  const gaps = times.slice(1).map((t, i) => t - times[i]);
  if (times.length) gaps.push(duration - times[times.length - 1]);
  return {
    keyframes: times.length,
    keyframeInterval: gaps.length ? round(gaps.reduce((a, b) => a + b, 0) / gaps.length, 2) : null,
    keyframeIntervalMax: gaps.length ? round(Math.max(...gaps), 2) : null,
  };
}

const COPY_FORMATS = new Set(['I420', 'I420A', 'NV12', 'RGBA', 'RGBX', 'BGRA', 'BGRX']);

/**
 * Copies a fixed set of HUD regions out of each decoded frame, reading it once over their bounding
 * rectangle (YUV copy when possible, else a canvas). crop(roi) returns an 8-bit RGB image.
 */
export class Cropper {
  /** With `canvas` ({rect, size}, as live_analysis.canvas_for), regions are fractions of the scaled picture. */
  constructor(regions, mode = 'auto', canvas = null) {
    this.regions = [...new Map(regions.map((r) => [JSON.stringify(r), r])).values()];
    this.mode = mode;
    this.canvas = canvas;
    this.size = null;
  }

  layout(w, h) {
    const { rect: [x0, y0, x1, y1], size: [W, H] } = this.canvas || { rect: [0, 0, w, h], size: [w, h] };
    const sw = x1 - x0, sh = y1 - y0, direct = sw === W && sh === H;
    // Source column/row of each canvas column/row, and its weights (bilinear with aligned pixel centres).
    const axis = (from, to, n, size, offset) => {
      const lo = new Int32Array(to - from), hi = new Int32Array(to - from), f = new Float64Array(to - from);
      for (let i = from; i < to; i++) {
        const s = Math.min(Math.max((i + .5) * (n / size) - .5, 0), n - 1), k = Math.floor(s);
        lo[i - from] = k + offset; hi[i - from] = Math.min(k + 1, n - 1) + offset; f[i - from] = s - k;
      }
      return { lo, hi, f };
    };
    this.slots = this.regions.map((roi) => {
      const [X1, Y1, X2, Y2] = cropRect(W, H, roi);
      const slot = { key: JSON.stringify(roi), w: Math.max(X2 - X1, 0), h: Math.max(Y2 - Y1, 0), direct };
      if (direct) return Object.assign(slot, { x: x0 + X1, y: y0 + Y1, x2: x0 + X1 + slot.w, y2: y0 + Y1 + slot.h });
      slot.cols = axis(X1, X1 + slot.w, sw, W, x0);
      slot.rows = axis(Y1, Y1 + slot.h, sh, H, y0);
      const first = (a) => (a.lo.length ? a.lo[0] : 0), last = (a) => (a.hi.length ? a.hi[a.hi.length - 1] + 1 : 0);
      return Object.assign(slot, { x: first(slot.cols), y: first(slot.rows), x2: last(slot.cols), y2: last(slot.rows) });
    });
    const live = this.slots.filter((s) => s.w && s.h);
    const bx = Math.min(...live.map((s) => s.x)), by = Math.min(...live.map((s) => s.y));
    // Even-aligned so 4:2:0 chroma rows and columns line up with the luma.
    this.box = {
      x: bx & ~1, y: by & ~1,
      x2: Math.min(w, Math.max(...live.map((s) => s.x2)) + 1 & ~1),
      y2: Math.min(h, Math.max(...live.map((s) => s.y2)) + 1 & ~1),
    };
    this.size = [w, h];
    this.out = [W, H];
  }

  /** Snapshot of the regions of `sample` (a Mediabunny VideoSample); the sample can be closed afterwards. */
  async grab(sample) {
    let w = sample.displayWidth, h = sample.displayHeight;
    if (!this.size || this.size[0] !== w || this.size[1] !== h) this.layout(w, h);
    let rgb = null;
    if (this.mode !== 'canvas' && COPY_FORMATS.has(sample.format) && !sample.rotation) {
      try {
        rgb = await this.copy(sample);
        this.mode = 'copy';
      } catch (error) {
        if (this.mode === 'copy') throw error;
        this.fallbackReason = error.message;
      }
    }
    if (!rgb) {
      rgb = this.draw(sample);
      this.mode = 'canvas';
    }
    const { box } = this, BW = box.x2 - box.x, crops = new Map();
    for (const s of this.slots) {
      const data = new Uint8Array(s.w * s.h * 3);
      if (s.direct) {
        for (let y = 0; y < s.h; y++) {
          const from = ((s.y - box.y + y) * BW + s.x - box.x) * 3;
          data.set(rgb.subarray(from, from + s.w * 3), y * s.w * 3);
        }
      } else {
        const { cols, rows } = s;
        for (let y = 0; y < s.h; y++) {
          const top = (rows.lo[y] - box.y) * BW, bottom = (rows.hi[y] - box.y) * BW, fy = rows.f[y];
          for (let x = 0; x < s.w; x++) {
            const a = (top + cols.lo[x] - box.x) * 3, b = (top + cols.hi[x] - box.x) * 3;
            const c = (bottom + cols.lo[x] - box.x) * 3, d = (bottom + cols.hi[x] - box.x) * 3, fx = cols.f[x];
            for (let k = 0; k < 3; k++) {
              const upper = (1 - fx) * rgb[a + k] + fx * rgb[b + k], lower = (1 - fx) * rgb[c + k] + fx * rgb[d + k];
              data[(y * s.w + x) * 3 + k] = Math.floor((1 - fy) * upper + fy * lower + .5);
            }
          }
        }
      }
      crops.set(s.key, { w: s.w, h: s.h, c: 3, data });
    }
    [w, h] = this.out;
    return {
      w, h,
      crop(roi) {
        const c = crops.get(JSON.stringify(roi));
        if (!c) throw new Error(`Region ${JSON.stringify(roi)} was not captured`);
        return c;
      },
    };
  }

  /** The bounding rectangle as RGB bytes, from the frame's own pixel data. */
  async copy(sample) {
    const { box } = this, format = sample.format, vis = sample.visibleRect, cs = sample.colorSpace || {};
    const BW = box.x2 - box.x, BH = box.y2 - box.y;
    const rect = { x: vis.left + box.x, y: vis.top + box.y, width: BW, height: BH };
    const buffer = new Uint8Array(sample.allocationSize({ rect }));
    const planes = await sample.copyTo(buffer, { rect });
    const out = new Uint8Array(BW * BH * 3);
    if (format.startsWith('RGB') || format.startsWith('BGR')) {
      const { offset, stride } = planes[0], bgr = format.startsWith('BGR');
      for (let y = 0; y < BH; y++) for (let x = 0; x < BW; x++) {
        const i = offset + y * stride + x * 4, j = (y * BW + x) * 3;
        out[j] = buffer[bgr ? i + 2 : i]; out[j + 1] = buffer[i + 1]; out[j + 2] = buffer[bgr ? i : i + 2];
      }
      return out;
    }
    // BT.601/709, limited or full range, 2x2 chroma blocks (as ffmpeg's unscaled yuv420p converter).
    const limited = cs.fullRange !== true, bt709 = cs.matrix === 'bt709';
    const ys = limited ? 1.164383 : 1, k = limited ? 1.138393 : 1;
    const [rv, gu, gv, bu] = (bt709 ? [1.5748, .187324, .468124, 1.8556] : [1.402, .344136, .714136, 1.772]).map((c) => c * k);
    const Yp = planes[0], nv12 = format === 'NV12', Up = planes[1], Vp = nv12 ? planes[1] : planes[2];
    const clamp = (v) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
    for (let y = 0; y < BH; y++) {
      const yRow = Yp.offset + y * Yp.stride, uRow = Up.offset + (y >> 1) * Up.stride, vRow = Vp.offset + (y >> 1) * Vp.stride;
      for (let x = 0; x < BW; x++) {
        const cx = x >> 1;
        const L = (buffer[yRow + x] - (limited ? 16 : 0)) * ys;
        const U = buffer[uRow + (nv12 ? cx * 2 : cx)] - 128, V = buffer[vRow + (nv12 ? cx * 2 + 1 : cx)] - 128;
        const j = (y * BW + x) * 3;
        out[j] = clamp(L + rv * V);
        out[j + 1] = clamp(L - gu * U - gv * V);
        out[j + 2] = clamp(L + bu * U);
      }
    }
    return out;
  }

  /** The bounding rectangle as RGB bytes, through a canvas (the browser converts the colours). */
  draw(sample) {
    const { box } = this, BW = box.x2 - box.x, BH = box.y2 - box.y;
    if (!this.ctx || this.canvas.width !== BW || this.canvas.height !== BH) {
      this.canvas = new OffscreenCanvas(BW, BH);
      this.ctx = this.canvas.getContext('2d', { alpha: false });
    }
    sample.draw(this.ctx, box.x, box.y, BW, BH, 0, 0, BW, BH);
    const pixels = this.ctx.getImageData(0, 0, BW, BH).data, out = new Uint8Array(BW * BH * 3);
    for (let i = 0, j = 0; j < out.length; i += 4, j += 3) { out[j] = pixels[i]; out[j + 1] = pixels[i + 1]; out[j + 2] = pixels[i + 2]; }
    return out;
  }
}

/** Calibration (locate_counter, locate_hp_bar, locate_combo_shift), one keyframe-snapped frame per sample. */
export async function calibrate(v, reader, profile, log, mode = 'auto') {
  const d = v.info.duration, P = profile;
  const counterTimes = linspace(Math.min(20, d * .05), d * .95, P.counter.calibration_samples);
  const hpTimes = linspace(Math.min(30, d * .1), Math.max(d - 30, d * .9), P.hp.calibration_samples);
  const packets = new EncodedPacketSink(v.video);
  const snap = new Map();
  for (const t of [...counterTimes, ...hpTimes]) {
    const key = await packets.getKeyPacket(t + v.t0, { metadataOnly: true });
    snap.set(t, key ? key.timestamp - v.t0 : t);
  }
  const distinct = (times) => new Set(times.map((t) => snap.get(t))).size;
  const useKeys = distinct(counterTimes) >= .75 * counterTimes.length && distinct(hpTimes) >= .75 * hpTimes.length;
  const at = (t) => (useKeys ? snap.get(t) : t);
  const all = [...new Set([...counterTimes, ...hpTimes].map(at))].sort((a, b) => a - b);
  const cropper = new Cropper(calibrationRegions(P), mode);
  const sink = sampleSink(v);
  const snapshots = new Map();
  let i = 0;
  for await (const sample of sink.samplesAtTimestamps(all.map((t) => t + v.t0))) {
    if (sample) {
      snapshots.set(all[i], await cropper.grab(sample));
      sample.close();
    }
    i++;
  }
  const pick = (times) => times.map((t) => snapshots.get(at(t))).filter(Boolean);
  const counter = locateCounter(pick(counterTimes), reader, P);
  const [hpRoi, hpLevel] = locateHpBar(pick(hpTimes), P);
  const combo = JSON.stringify(counter.roi) === JSON.stringify(P.counter.layouts[1]);
  const comboShift = combo ? locateComboShift(pick(counterTimes), P, v.comboBytes) : [0, 0];
  const best = Math.max(...counter.hits);
  log?.(`Calibration (${all.length} frames, ${useKeys ? 'at keyframes' : 'exact times'}, ${cropper.mode} capture): `
    + `kill counter at ${counter.roi.join(', ')} read in ${best} of ${counterTimes.length} frames `
    + `(other layout ${counter.hits.reduce((a, b) => a + b, 0) - best}); `
    + `HP bar ${hpRoi ? `${hpRoi.join(', ')} lit above ${hpLevel}` : 'none'}`
    + `${combo ? `; COMBO offset ${comboShift.join(', ')}` : ''}`);
  if (cropper.fallbackReason) log?.(`Frame copy unavailable (${cropper.fallbackReason}); using the canvas.`);
  return { roi: counter.roi, nameReference: counter.nameReference, hpRoi, hpLevel, combo, comboShift, frames: all.length };
}

/** scan_video without the scene/minimap pass: read the HUD every `interval` s, in decode order. */
export async function scan(v, hud, reader, profile, interval, { onProgress, shouldStop, mode = 'auto', inFlight = 3 } = {}) {
  const sink = sampleSink(v);
  const cropper = new Cropper(scanRegions(profile, hud), mode);
  const readings = [], checks = [], pending = [];
  let next = 0, seconds = 0, decoded = 0, readTime = 0, captureTime = 0, lastReport = 0, stopped = false;
  const started = performance.now();

  const finishOldest = async () => {
    const { t, grab } = pending.shift();
    const before = performance.now();
    const frame = await grab;
    const grabbed = performance.now();
    const now = readHud(frame, t, hud, reader, profile);
    captureTime += grabbed - before;
    readTime += performance.now() - before;
    readings.push(now);
    // An instant HP refill is a respawn candidate (regeneration only adds ~0.1 per half second).
    if (hud.hpRoi && readings.length >= 2) {
      const low = readings.slice(-4, -1).filter((r) => now.time - r.time <= 1.1 && (r.hp ?? 1) < .65);
      if (now.hp >= .95 && low.length && (readings[readings.length - 2].hp ?? 1) < .65) {
        checks.push({ time: now.time, from_hp: Math.min(...low.map((r) => r.hp)), due: now.time + .5 });
      }
    }
  };

  for await (const sample of sink.samples()) {
    decoded++;
    const t = sample.timestamp - v.t0;
    seconds = t;
    if (t + .001 < next) { sample.close(); continue; }
    next = t + interval - .001;
    pending.push({ t, grab: cropper.grab(sample).finally(() => sample.close()) });
    if (pending.length >= inFlight) await finishOldest();
    if (performance.now() - lastReport > 500) {
      lastReport = performance.now();
      onProgress?.({ seconds: t, decoded, readings: readings.length, elapsed: (lastReport - started) / 1000 });
      if (shouldStop?.()) { stopped = true; break; }
    }
  }
  while (pending.length) await finishOldest();
  if (!readings.length) throw new Error('No readable frames.');
  return {
    readings, stopped,
    // Python records a respawn check once a frame half a second later has been processed.
    respawn_checks: checks.filter((c) => c.due <= seconds + .001).map(({ time, from_hp }) => ({ time, from_hp })),
    roi: hud.roi, hp_roi: hud.hpRoi, hp_level: hud.hpLevel, combo_shift: hud.comboShift,
    duration: seconds, decoded, readTime: readTime / 1000, captureTime: captureTime / 1000,
    capture: cropper.mode, scanTime: (performance.now() - started) / 1000,
  };
}

/** locate_killfeed's per-frame half: each frame's killfeed-like rows and a Stillness of name pixels. */
export async function locateFrames(v, times, canvas, mode = 'auto', P = null) {
  const sink = sampleSink(v), cropper = new Cropper([[0, 0, 1, 1]], mode, canvas);
  const rowsPerFrame = [], numbersPerFrame = [], stillness = new Stillness();
  const most = P ? Math.max(...P.streaks.costs) : 0;
  let size = null;
  for await (const sample of sink.samplesAtTimestamps(times.map((t) => t + v.t0))) {
    if (sample) {
      const frame = await cropper.grab(sample);
      sample.close();
      size = [frame.w, frame.h];
      const full = frame.crop([0, 0, 1, 1]);
      rowsPerFrame.push(feedRows(textLines(full, 3, stillness)).map((r) => ({ ...r, pix: stillness.pixels(r) })));
      numbersPerFrame.push(P ? counterCandidates(full, P, most) : []);
    }
  }
  return { rowsPerFrame, numbersPerFrame, size, count: stillness.count, n: stillness.n, w: stillness.w };
}

/** locate_killfeed's sampling: full frames spread over the recording, snapped to keyframes. */
export async function calibrateLive(v, P, log, mode = 'auto', pool = null) {
  const d = v.info.duration, times = linspace(d * .03, d * .97, P.locate_samples);
  const packets = new EncodedPacketSink(v.video);
  const snapped = [];
  for (const t of times) {
    const key = await packets.getKeyPacket(t + v.t0, { metadataOnly: true });
    snapped.push(key ? key.timestamp - v.t0 : t);
  }
  const useKeys = new Set(snapped).size >= .75 * times.length;
  const all = [...new Set(useKeys ? snapped : times)].sort((a, b) => a - b);
  const sink = sampleSink(v);
  const canvas = await picture(v, sink, packets, mode, P);
  // The frames are shared out in consecutive runs to `pool` workers when given, else read here.
  const parts = pool ? await pool.locate(all, canvas) : [await locateFrames(v, all, canvas, mode, P)];
  const rowsPerFrame = parts.flatMap((part) => part.rowsPerFrame), stillness = new Stillness();
  for (const part of parts) if (part.n) stillness.merge(part.count, part.n, part.w);
  const size = parts.find((part) => part.size)?.size;
  if (!size) throw new Error('No readable frames.');
  const feed = locateKillfeed(rowsPerFrame.map((rows) => stillness.drop(rows)), ...size, canvas);
  const numbers = parts.flatMap((part) => part.numbersPerFrame).flatMap((found, frame) => found.map((n) => ({ ...n, frame })));
  Object.assign(feed, counterBox(numbers, ...size, rowsPerFrame.length, P));
  const [x0, y0, x1, y1] = canvas.rect;
  if (x1 - x0 !== canvas.size[0] || y1 - y0 !== canvas.size[1]) {
    log?.(`Game picture: ${x1 - x0}x${y1 - y0} at (${x0}, ${y0}) of the frame, read at ${canvas.size.join('x')}`
      + (canvas.stretch !== 1 ? ` (width corrected x${canvas.stretch}: the recording stretched it)` : ''));
  }
  if (feed.feed_canvas.size[1] !== canvas.size[1]) log?.(`Killfeed set to a different size: read rescaled to ${feed.feed_canvas.size.join('x')}`);
  log?.(`Killfeed (${all.length} frames, ${useKeys ? 'at keyframes' : 'exact times'}): box ${feed.box.join(', ')}, `
    + `rows ${feed.pitch} px apart, seen in ${feed.frames} frames`);
  log?.(feed.counter ? `Points counter: ${feed.counter.join(', ')} (read in ${feed.counter_frames} of ${rowsPerFrame.length} frames); `
    + `streak icons ${feed.icons ? 'read' : 'not read (not in the reference layout)'}`
    : 'Points counter: not found; kills come from the score popups and the killfeed');
  return feed;
}

/** live_analysis.picture: the game picture inside any black bars, unstretched, from 24 frames (at keyframes). */
async function picture(v, sink, packets, mode, P) {
  const d = v.info.duration, times = [];
  for (const t of linspace(d * .05, d * .95, 24)) {
    const key = await packets.getKeyPacket(t + v.t0, { metadataOnly: true });
    times.push(key ? key.timestamp - v.t0 : t);
  }
  const cropper = new Cropper([[0, 0, 1, 1]], mode), frames = [];
  for await (const sample of sink.samplesAtTimestamps([...new Set(times)].sort((a, b) => a - b).map((t) => t + v.t0))) {
    if (sample) {
      frames.push((await cropper.grab(sample)).crop([0, 0, 1, 1]));
      sample.close();
    }
  }
  if (!frames.length) throw new Error('No readable frames.');
  const rect = contentRect(frames);
  return canvasFor(rect, HEIGHT, unstretch(frames, rect, P));
}

/** scan_live: readings and compact killfeed data on the `P.interval` grid, for frames from `start` to `end` s. */
export async function scanLive(v, feed, P, { onProgress, shouldStop, mode = 'auto', inFlight = 3, start = 0, end = Infinity } = {}) {
  const sink = sampleSink(v);
  const groups = liveRegions(feed, P).map(({ canvas, regions }) => ({
    regions: new Set(regions.map((r) => JSON.stringify(r))), cropper: new Cropper(regions, mode, canvas),
  }));
  const readings = [], samples = [], pending = [], step = P.interval;
  let next = Math.ceil(start / step - 1e-9) * step, seconds = start, decoded = 0, lastReport = 0, stopped = false, shape = null;
  const started = performance.now();
  const grab = async (sample) => {
    const parts = await Promise.all(groups.map((g) => g.cropper.grab(sample)));
    return { w: parts[0].w, h: parts[0].h, crop: (roi) => parts[groups.findIndex((g) => g.regions.has(JSON.stringify(roi)))].crop(roi) };
  };
  const finishOldest = async () => {
    const { t, frame } = pending.shift();
    const { reading, sample, shape: s } = readLive(await frame, t, feed, P);
    readings.push(reading); samples.push(sample); shape = s;
  };
  for await (const sample of sink.samples(start + v.t0, end === Infinity ? undefined : end + v.t0)) {
    decoded++;
    const t = sample.timestamp - v.t0;
    if (t + .001 >= end) { sample.close(); break; }
    seconds = t;
    if (t + .001 < next) { sample.close(); continue; }
    next = (Math.floor((t + .001) / step) + 1) * step;
    pending.push({ t, frame: grab(sample).finally(() => sample.close()) });
    if (pending.length >= inFlight) await finishOldest();
    if (performance.now() - lastReport > 500) {
      lastReport = performance.now();
      onProgress?.({ seconds: t, done: t - start, decoded, readings: readings.length, elapsed: (lastReport - started) / 1000 });
      if (shouldStop?.()) { stopped = true; break; }
    }
  }
  while (pending.length) await finishOldest();
  if (!readings.length) throw new Error('No readable frames.');
  return {
    scan: { readings, feed, duration: seconds, interval: P.interval, stopped, decoded, capture: groups[0].cropper.mode,
      scanTime: (performance.now() - started) / 1000 },
    data: { shape, samples },
  };
}

/** match_end_readings, second half: read the replay-layout panel after the normal one disappears. */
export async function readMatchEnd(v, scanResult, reader, profile, interval, maxRise = 4) {
  const plan = matchEndPlan(scanResult);
  if (!plan) return { final: [], switchTime: null };
  const others = profile.counter.layouts.filter((l) => JSON.stringify(l) !== JSON.stringify(scanResult.roi));
  const cropper = new Cropper(others);
  const sink = sampleSink(v);
  const found = [];
  let t = plan.start + interval / 2, misses = 0;
  while (t <= scanResult.duration && misses < 4) {
    const sample = await sink.getSample(t + v.t0);
    if (!sample) break;
    const frame = await cropper.grab(sample);
    sample.close();
    let value = null;
    for (const layout of others) {
      const read = reader.read(frame.crop(layout));
      if (read.count !== undefined) { value = read.count; break; }
    }
    if (value !== null && plan.base <= value && value <= plan.base + maxRise) {
      found.push({ time: round(t, 3), count: value, who: 1, end_of_match: true });
      misses = 0;
    } else if (found.length || t - plan.start > 2) {
      misses++;
    }
    t += interval;
  }
  return { final: found, switchTime: plan.start };
}

/** Cut [start, end] s without re-encoding (keyframe to keyframe); returns the MP4 bytes and the span covered. */
export async function cutClip(v, start, end) {
  const options = { verifyKeyPackets: true };
  const vs = new EncodedPacketSink(v.video);
  const first = (await vs.getKeyPacket(start + v.t0, options)) ?? (await vs.getFirstKeyPacket(options));
  let stop = await vs.getKeyPacket(end + v.t0, options);
  if (stop && stop.timestamp < end + v.t0 - 1e-6) stop = await vs.getNextKeyPacket(stop, options);
  if (stop && stop.sequenceNumber <= first.sequenceNumber) stop = await vs.getNextKeyPacket(first, options);

  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const videoSource = new EncodedVideoPacketSource(v.info.codec);
  output.addVideoTrack(videoSource, { rotation: v.info.rotation });
  let audioSource = null, audioSink = null, audioConfig = null;
  if (v.audio && v.info.audio?.codec) {
    try {
      audioSource = new EncodedAudioPacketSource(v.info.audio.codec);
      output.addAudioTrack(audioSource);
      audioSink = new EncodedPacketSink(v.audio);
      audioConfig = await v.audio.getDecoderConfig();
    } catch {
      audioSource = null;
    }
  }
  await output.start();
  const offset = first.timestamp, stopTime = stop ? stop.timestamp : Infinity;
  const videoConfig = await v.video.getDecoderConfig();

  const videoPackets = vs.packets(first, stop ?? undefined);
  let audioPackets = null;
  if (audioSource) {
    const a0 = (await audioSink.getPacket(offset)) ?? (await audioSink.getFirstPacket());
    audioPackets = a0 ? audioSink.packets(a0) : null;
  }
  // Interleave the two tracks by timestamp, as a muxer expects.
  let nv = await videoPackets.next(), na = audioPackets ? await audioPackets.next() : { done: true };
  let videoFirst = true, audioFirst = true, last = offset;
  while (!nv.done || !na.done) {
    const takeVideo = !nv.done && (na.done || nv.value.timestamp <= na.value.timestamp);
    if (takeVideo) {
      const p = nv.value;
      await videoSource.add(p.clone({ timestamp: p.timestamp - offset }), videoFirst ? { decoderConfig: videoConfig } : undefined);
      videoFirst = false;
      last = Math.max(last, p.timestamp + p.duration);
      nv = await videoPackets.next();
    } else {
      const p = na.value;
      if (p.timestamp >= stopTime || p.timestamp >= last && nv.done) { await audioPackets.return(); na = { done: true }; continue; }
      if (p.timestamp >= offset) {
        await audioSource.add(p.clone({ timestamp: p.timestamp - offset }), audioFirst ? { decoderConfig: audioConfig } : undefined);
        audioFirst = false;
      }
      na = await audioPackets.next();
    }
  }
  await videoPackets.return();
  await output.finalize();
  return { bytes: output.target.buffer, start: offset - v.t0, end: last - v.t0 };
}


