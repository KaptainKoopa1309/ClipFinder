// Live (screen-recorded) recordings, ported from live_analysis.py function by function.
// Images are {w, h, c, data} with RGB bytes (cv2 frames are BGR; the channel order is swapped here).
import { resize, gray, matchTemplateBest, percentile, median, round } from './cv.js';

/** Loads live-profile.json (constants and the quarter-size killcam titles). */
export async function loadLiveProfile(base) {
  const r = await fetch(new URL('live-profile.json', base));
  if (!r.ok) throw new Error(`Cannot load live-profile.json: ${r.status}`);
  const P = await r.json();
  for (const t of Object.values(P.titles)) Object.assign(t, { w: t.shape[1], h: t.shape[0], c: 1, data: Float32Array.from(t.data) });
  P.counter_digits = P.counter_digits.data.map((d) => ({ w: P.counter_digits.shape[2], h: P.counter_digits.shape[1], c: 1, data: Float32Array.from(d) }));
  P.popup_digits = P.popup_digits.data.map((d) => ({ w: P.popup_digits.shape[2], h: P.popup_digits.shape[1], c: 1, data: Float32Array.from(d) }));
  return P;
}

// ---- the game picture: inside any black bars, read at 1080 rows ----

export const HEIGHT = 1080, FEED_PITCH = 35;
const BG_HALF = 15, BG_EDGE = 40, CHROMA = 10, TEXT_EDGE = 40, LIGHT_EDGE = 25, BLUE_TEXT = 20;
// Width corrections tried for a stretched or squeezed picture, 0.75-1.35 in 0.025 steps, nearest 1 first.
export const STRETCHES = Array.from({ length: 25 }, (_, k) => Math.round((.75 + .025 * k) * 1000) / 1000)
  .sort((a, b) => Math.abs(a - 1) - Math.abs(b - 1) || a - b);

/** content_rect: the game picture inside letterbox/pillarbox bars, from full RGB frames. */
export function contentRect(frames) {
  const edges = [];
  for (const { w, h, c, data: D } of frames) {
    const rowLit = new Int32Array(h), colLit = new Int32Array(w);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y * w + x) * c;
        if (Math.max(D[j], D[j + 1], D[j + 2]) > 30) { rowLit[y]++; colLit[x]++; }
      }
    }
    let r0 = -1, r1 = -1, c0 = -1, c1 = -1;
    for (let y = 0; y < h; y++) if (rowLit[y] / w > .02) { if (r0 < 0) r0 = y; r1 = y; }
    for (let x = 0; x < w; x++) if (colLit[x] / h > .02) { if (c0 < 0) c0 = x; c1 = x; }
    if (r0 >= 0 && c0 >= 0) edges.push([c0, r0, c1 + 1, r1 + 1]);
  }
  const { w, h } = frames[0];
  if (!edges.length) return [0, 0, w, h];
  let [x0, y0, x1, y1] = [0, 1, 2, 3].map((k) => Math.trunc(median(edges.map((e) => e[k]))));
  if (x0 < .01 * w) x0 = 0;
  if (y0 < .01 * h) y0 = 0;
  if (x1 > .99 * w) x1 = w;
  if (y1 > .99 * h) y1 = h;
  return [x0, y0, x1, y1];
}

/** canvas_for: the game picture scaled to `height` rows, its width times `stretch`. */
export function canvasFor(rect, height = HEIGHT, stretch = 1) {
  const [x0, y0, x1, y1] = rect;
  return { rect: [...rect], size: [Math.floor((x1 - x0) * height / (y1 - y0) * stretch + .5), height], stretch };
}

/** region: `roi` of the canvas, sampled bilinearly from a full RGB frame (as video.js's Cropper). */
export function region(img, canvas, roi) {
  const { rect: [x0, y0, x1, y1], size: [W, H] } = canvas, sw = x1 - x0, sh = y1 - y0;
  const X1 = Math.trunc(W * roi[0]), Y1 = Math.trunc(H * roi[1]), X2 = Math.trunc(W * roi[2]), Y2 = Math.trunc(H * roi[3]);
  const w = Math.max(X2 - X1, 0), h = Math.max(Y2 - Y1, 0), out = new Uint8Array(w * h * 3), D = img.data, c = img.c;
  const axis = (i, n, size) => {
    const s = Math.min(Math.max((i + .5) * (n / size) - .5, 0), n - 1), k = Math.floor(s);
    return [k, Math.min(k + 1, n - 1), s - k];
  };
  for (let y = 0; y < h; y++) {
    if (sw === W && sh === H) {
      for (let x = 0; x < w; x++) for (let k = 0; k < 3; k++) out[(y * w + x) * 3 + k] = D[((y0 + Y1 + y) * img.w + x0 + X1 + x) * c + k];
      continue;
    }
    const [ry, ry2, fy] = axis(Y1 + y, sh, H), top = (y0 + ry) * img.w, bottom = (y0 + ry2) * img.w;
    for (let x = 0; x < w; x++) {
      const [rx, rx2, fx] = axis(X1 + x, sw, W);
      for (let k = 0; k < 3; k++) {
        const a = D[(top + x0 + rx) * c + k], b = D[(top + x0 + rx2) * c + k], cc = D[(bottom + x0 + rx) * c + k], d = D[(bottom + x0 + rx2) * c + k];
        const upper = (1 - fx) * a + fx * b, lower = (1 - fx) * cc + fx * d;
        out[(y * w + x) * 3 + k] = Math.floor((1 - fy) * upper + fy * lower + .5);
      }
    }
  }
  return { w, h, c: 3, data: out };
}

/** unstretch: the width correction at which the KILLCAM title matches best (1 if none). */
export function unstretch(frames, rect, P) {
  const scores = STRETCHES.map((s) => {
    const canvas = canvasFor(rect, HEIGHT, s);
    return Math.max(...frames.map((f) => titleScore(region(f, canvas, P.killcam_roi), P.titles.killcam, P)));
  });
  const best = Math.max(...scores);
  if (best < P.away_score) return 1;
  return STRETCHES.find((s, k) => scores[k] >= best - .05);
}

// ---- name colours, against the local background ----

let scratch = null;
const buffers = (m) => {
  if (!scratch || scratch.m < m) scratch = { m, sums: new Int32Array(m * 3), kept: new Int32Array(m * 4) };
  return scratch;
};

/**
 * colours (with relative): gold, red and text masks and the row redness, from each pixel's step from its background.
 * With `all` false, the light mask and redness are skipped (locating the killfeed only needs the other three).
 */
export function colours(img, all = true) {
  const { w, h, c, data: D } = img, n = w * h, W = w + 1, m = W * (h + 1);
  const { sums, kept } = buffers(m);
  const gold = new Uint8Array(n), red = new Uint8Array(n), text = new Uint8Array(n);
  const light = all ? new Uint8Array(n) : null, redness = all ? new Uint8Array(n) : null;
  const y1 = new Int32Array(h), y2 = new Int32Array(h), x1 = new Int32Array(w), x2 = new Int32Array(w);
  for (let y = 0; y < h; y++) { y1[y] = Math.max(0, y - BG_HALF); y2[y] = Math.min(h, y + BG_HALF + 1); }
  for (let x = 0; x < w; x++) { x1[x] = Math.max(0, x - BG_HALF); x2[x] = Math.min(w, x + BG_HALF + 1); }
  sums.fill(0, 0, m * 3);
  for (let y = 0; y < h; y++) {
    const up = y * W * 3, cur = (y + 1) * W * 3;
    let r0 = 0, r1 = 0, r2 = 0;
    for (let x = 0, j = y * w * c; x < w; x++, j += c) {
      r0 += D[j]; r1 += D[j + 1]; r2 += D[j + 2];
      const o = (x + 1) * 3;
      sums[cur + o] = sums[up + o] + r0; sums[cur + o + 1] = sums[up + o + 1] + r1; sums[cur + o + 2] = sums[up + o + 2] + r2;
    }
  }
  const keep = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    const a = y2[y] * W * 3, b = y1[y] * W * 3, dy = y2[y] - y1[y];
    for (let x = 0, i = y * w, j = y * w * c; x < w; x++, i++, j += c) {
      const L = x1[x] * 3, R = x2[x] * 3, area = dy * (x2[x] - x1[x]), edge = BG_EDGE * area;
      const s0 = sums[a + R] - sums[b + R] - sums[a + L] + sums[b + L];
      const s1 = sums[a + R + 1] - sums[b + R + 1] - sums[a + L + 1] + sums[b + L + 1];
      const s2 = sums[a + R + 2] - sums[b + R + 2] - sums[a + L + 2] + sums[b + L + 2];
      keep[i] = Math.abs(D[j] * area - s0) <= edge && Math.abs(D[j + 1] * area - s1) <= edge && Math.abs(D[j + 2] * area - s2) <= edge ? 1 : 0;
    }
  }
  kept.fill(0, 0, m * 4);
  for (let y = 0; y < h; y++) {
    const up = y * W * 4, cur = (y + 1) * W * 4;
    let r0 = 0, r1 = 0, r2 = 0, r3 = 0;
    for (let x = 0, i = y * w, j = y * w * c; x < w; x++, i++, j += c) {
      if (keep[i]) { r0 += D[j]; r1 += D[j + 1]; r2 += D[j + 2]; r3++; }
      const o = (x + 1) * 4;
      kept[cur + o] = kept[up + o] + r0; kept[cur + o + 1] = kept[up + o + 1] + r1;
      kept[cur + o + 2] = kept[up + o + 2] + r2; kept[cur + o + 3] = kept[up + o + 3] + r3;
    }
  }
  for (let y = 0; y < h; y++) {
    const a3 = y2[y] * W * 3, b3 = y1[y] * W * 3, a4 = y2[y] * W * 4, b4 = y1[y] * W * 4, dy = y2[y] - y1[y];
    for (let x = 0, i = y * w, j = y * w * c; x < w; x++, i++, j += c) {
      const L3 = x1[x] * 3, R3 = x2[x] * 3, L4 = x1[x] * 4, R4 = x2[x] * 4, area = dy * (x2[x] - x1[x]);
      const count = kept[a4 + R4 + 3] - kept[b4 + R4 + 3] - kept[a4 + L4 + 3] + kept[b4 + L4 + 3];
      const use = 20 * count > area, div = Math.max(count, 1);
      const r = D[j], g = D[j + 1], b = D[j + 2];
      const sR = r - (use ? (kept[a4 + R4] - kept[b4 + R4] - kept[a4 + L4] + kept[b4 + L4]) / div
        : (sums[a3 + R3] - sums[b3 + R3] - sums[a3 + L3] + sums[b3 + L3]) / area);
      const sG = g - (use ? (kept[a4 + R4 + 1] - kept[b4 + R4 + 1] - kept[a4 + L4 + 1] + kept[b4 + L4 + 1]) / div
        : (sums[a3 + R3 + 1] - sums[b3 + R3 + 1] - sums[a3 + L3 + 1] + sums[b3 + L3 + 1]) / area);
      const sB = b - (use ? (kept[a4 + R4 + 2] - kept[b4 + R4 + 2] - kept[a4 + L4 + 2] + kept[b4 + L4 + 2]) / div
        : (sums[a3 + R3 + 2] - sums[b3 + R3 + 2] - sums[a3 + L3 + 2] + sums[b3 + L3 + 2]) / area);
      // cv2 order is B, G, R: the mean adds them in that order.
      const mean = (sB + sG + sR) / 3, R = sR - mean, G = sG - mean, B = sB - mean, lo = Math.min(R, G), hi = r > g ? r : g;
      // pale_gold: the fill in absolute terms (dark backgrounds, orange or yellow scenery).
      const pale = hi > 165 && Math.min(r, g) - b > 25 && Math.abs(r - g) < 35 && (hi - b) / Math.max(hi, 1) < .55;
      // Blue pixels (teammates' names) are never the player's name.
      const cool = b - hi > BLUE_TEXT;
      gold[i] = ((lo > CHROMA && Math.abs(R - G) < lo && B < -CHROMA) || pale) && !cool ? 1 : 0;
      red[i] = R > CHROMA && R - G > CHROMA && R - B > CHROMA ? 1 : 0;
      // Text is a letter's fill (brighter than the background); its dark outline would join letters up.
      text[i] = Math.max(sB, sG, sR) > TEXT_EDGE ? 1 : 0;
      if (all) {
        light[i] = mean > LIGHT_EDGE && !cool ? 1 : 0;
        redness[i] = Math.min(Math.floor(Math.max(R - Math.max(G, B), 0) * 4), 255);
      }
    }
  }
  return { gold, red, text, light, redness };
}

// ---- connected components (cv2.connectedComponentsWithStats, 8-connectivity) ----

/** Components of a 0/1 mask in raster order: [{x, y, w, h, area}], with the label image as `.labels`. */
export function components(mask, w, h) {
  const label = new Int32Array(w * h), stack = new Int32Array(w * h), out = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    const id = out.length + 1;
    let top = 0, x1 = w, y1 = h, x2 = -1, y2 = -1, area = 0;
    stack[top++] = start; label[start] = id;
    while (top) {
      const p = stack[--top], py = (p / w) | 0, px = p - py * w;
      area++;
      if (px < x1) x1 = px; if (px > x2) x2 = px; if (py < y1) y1 = py; if (py > y2) y2 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const q = ny * w + nx;
          if (mask[q] && !label[q]) { label[q] = id; stack[top++] = q; }
        }
      }
    }
    out.push({ x: x1, y: y1, w: x2 - x1 + 1, h: y2 - y1 + 1, area });
  }
  out.labels = label;
  return out;
}

// ---- locating the killfeed ----

/** long_runs: clears horizontal runs of `length`+ set pixels of `mask` in rows y1..y2, columns x1..x2. */
function dropLongRuns(mask, w, y1, y2, x1, x2, length) {
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2;) {
      if (!mask[y * w + x]) { x++; continue; }
      let end = x;
      while (end < x2 && mask[y * w + end]) end++;
      if (end - x >= length) mask.fill(0, y * w + x, y * w + end);
      x = end;
    }
  }
}

/** text_lines: horizontal runs of letter-sized name components. */
export function textLines(img, minLetters = 3, stillness = null) {
  const { gold, red, text } = colours(img, false), mask = new Uint8Array(gold.length), { w, h } = img;
  for (let i = 0; i < mask.length; i++) mask[i] = text[i] | gold[i] | red[i];
  dropLongRuns(mask, w, 0, h, 0, w, 30);   // a row band's edges: letters stay apart
  stillness?.add(mask, w);
  const all = components(mask, w, h), tint = new Int32Array(all.length + 1);
  for (let i = 0; i < mask.length; i++) if ((gold[i] | red[i]) && mask[i]) tint[all.labels[i]]++;
  const comps = all.map((s, i) => ({ ...s, i }))
    .filter((s) => s.h >= 9 && s.h <= 24 && s.w >= 2 && s.w <= 90)
    .sort((a, b) => a.x - b.x || a.i - b.i);
  const lines = [];
  for (const s of comps) {
    // Letters that touch are one wider piece, counted as width / 13 letters.
    const mid = s.y + s.h / 2, letters = Math.max(1, Math.floor(s.w / 13 + .5));
    const tinted = 2 * tint[s.i + 1] > s.area ? letters : 0;
    const line = lines.find((l) => Math.abs(l.mid - mid) <= 4 && s.x - l.x2 >= 0 && s.x - l.x2 <= 16);
    if (line) { line.x2 = Math.max(line.x2, s.x + s.w); line.n += letters; line.c += tinted; } else lines.push({ x1: s.x, x2: s.x + s.w, mid, n: letters, c: tinted });
  }
  return lines.filter((l) => l.n >= minLetters);
}

/** feed_rows: killer name, weapon-icon gap, victim name on one line; one of the names red or gold. */
export function feedRows(lines) {
  const rows = [];
  for (const a of lines) {
    const b = lines.find((b) => b !== a && Math.abs(a.mid - b.mid) <= 4 && b.x1 - a.x2 >= 25 && b.x1 - a.x2 <= 170
      && (2 * a.c >= a.n || 2 * b.c >= b.n));
    if (b) rows.push({ x1: a.x1, x2: b.x2, mid: (a.mid + b.mid) / 2 });
  }
  return rows;
}

/** Stillness: how often each pixel is name text across frames, to drop static text. */
export class Stillness {
  constructor() { this.n = 0; this.count = null; }

  add(mask, w) {
    if (!this.count) { this.count = new Int32Array(mask.length); this.w = w; }
    for (let i = 0; i < mask.length; i++) this.count[i] += mask[i];
    this.n++;
    this.last = mask;
  }

  /** The text pixels of the last frame added in a row's area (start to end, middle +-8 px), as flat indices. */
  pixels(r) {
    const { w, last } = this, h = last.length / w, out = [];
    for (let y = Math.max(0, Math.trunc(r.mid - 8)); y < Math.min(h, Math.trunc(r.mid + 8)); y++) {
      for (let x = r.x1; x < Math.min(w, r.x2); x++) if (last[y * w + x]) out.push(y * w + x);
    }
    return out;
  }

  /** Add the counts another Stillness gathered (over `n` frames). */
  merge(count, n, w) {
    if (!this.count) { this.count = new Int32Array(count.length); this.w = w; }
    for (let i = 0; i < count.length; i++) this.count[i] += count[i];
    this.n += n;
  }

  /** Rows whose letters are text in 75%+ of frames: static text. */
  drop(found, share = .75) {
    if (this.n < 10) return found;
    const { w, count } = this, h = count.length / w;
    return found.filter((r) => {
      if (r.pix?.length) return median(r.pix.map((i) => count[i])) < share * this.n;
      const values = [];
      for (let y = Math.max(0, Math.trunc(r.mid - 8)); y < Math.min(h, Math.trunc(r.mid + 8)); y++) {
        for (let x = r.x1; x < Math.min(w, r.x2); x++) values.push(count[y * w + x]);
      }
      return !values.length || percentile(values, 90) < share * this.n;
    });
  }
}

/** locate_killfeed, from the killfeed rows of each sampled canvas (rowsPerFrame[k] = feedRows(...)). */
export function locateKillfeed(rowsPerFrame, width, height, canvas) {
  const found = rowsPerFrame.flatMap((rows, frame) => rows.map((r) => ({ ...r, frame })));
  const bin = (x) => Math.floor(x / 6);
  const frames = new Map();
  for (const r of found) {
    const b = bin(r.x1);
    if (!frames.has(b)) frames.set(b, new Set());
    frames.get(b).add(r.frame);
  }
  const support = new Map();
  for (const [b, f] of frames) support.set(b, new Set([...f, ...(frames.get(b - 1) || []), ...(frames.get(b + 1) || [])]).size);
  if (!support.size || Math.max(...support.values()) < 5) {
    throw new Error('Cannot find the killfeed in this video; is it a live CODM recording?');
  }
  let best = [...support.keys()].reduce((a, b) => (support.get(b) > support.get(a) ? b : a));
  const heights = (b) => median(found.filter((r) => Math.abs(bin(r.x1) - b) <= 1).map((r) => r.mid));
  const candidates = [...support.keys()].filter((b) => support.get(b) >= .5 * support.get(best)
    && Math.abs(heights(b) - heights(best)) <= 20);
  if (candidates.length) best = Math.min(...candidates);
  const left = Math.trunc(median(found.filter((r) => Math.abs(bin(r.x1) - best) <= 1).map((r) => r.x1)));
  const column = found.filter((r) => Math.abs(r.x1 - left) <= 8);
  const byFrame = new Map();
  for (const r of column) {
    if (!byFrame.has(r.frame)) byFrame.set(r.frame, []);
    byFrame.get(r.frame).push(r.mid);
  }
  const gaps = [];
  for (const mids of byFrame.values()) {
    mids.sort((a, b) => a - b);
    for (let i = 1; i < mids.length; i++) if (mids[i] - mids[i - 1] > 15) gaps.push(mids[i] - mids[i - 1]);
  }
  // A missed row makes a double gap, so each gap counts per row it spans.
  const base = gaps.length ? percentile(gaps, 25) : 0;
  const pitch = gaps.length ? median(gaps.map((g) => g / Math.max(1, Math.floor(g / base + .5)))) : 35 * height / 1080;
  const top = percentile(column.map((r) => r.mid), 3);
  const deepest = Math.max(...[...byFrame.values()].map((m) => m.length));
  const right = percentile(column.map((r) => r.x2), 95);
  const box = [Math.max(0, left - 14) / width, Math.max(0, top - 22) / height,
    Math.min(width, right + 40) / width, Math.min(height, top + pitch * Math.max(deepest, 3) + 22) / height];
  // A killfeed set over 10% larger or smaller than default is read rescaled to the default size.
  const scale = Math.abs(FEED_PITCH / pitch - 1) > .1 ? FEED_PITCH / pitch : 1;
  const feedCanvas = { rect: canvas.rect, size: [Math.floor(width * scale + .5), Math.floor(height * scale + .5)] };
  return {
    box: box.map((v) => round(v, 4)), pitch: round(pitch, 2), rows: deepest, frames: byFrame.size, samples: rowsPerFrame.length,
    canvas, feed_canvas: feedCanvas, read_pitch: round(pitch * scale, 2),
  };
}

// ---- per-sample reading ----

/** gold_bands: rows of the killfeed box near gold text, where row signatures are kept. */
export function goldBands(gold, w, h, margin = 18) {
  const profile = new Uint8Array(h), keep = new Uint8Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 4; x < w; x++) s += gold[y * w + x];
    profile[y] = s >= 6 ? 1 : 0;
  }
  let y = 0;
  while (y < h) {
    if (profile[y]) {
      let y2 = y;
      while (y2 + 1 < h && profile[y2 + 1]) y2++;
      if (y2 - y + 1 >= 8) {
        // Keep a text-height run's middle +-18 rows, a taller run whole plus 6 rows each side.
        const c = (y + y2) >> 1;
        for (let k = Math.max(0, Math.min(c - margin, y - 6)); k < Math.min(h, Math.max(y2 + 6, c + margin)); k++) keep[k] = 1;
      }
      y = y2 + 1;
    } else y++;
  }
  const rows = [];
  for (let k = 0; k < h; k++) if (keep[k]) rows.push(k);
  return rows;
}

function titleScore(region, title, P) {
  const g = gray(region), s = P.title_scale;
  const area = resize(g, Math.max(1, Math.floor(g.w / s)), Math.max(1, Math.floor(g.h / s)), 'area');
  return round(matchTemplateBest(area, title).score, 3);
}

function spectateScore(strip) {
  const cells = resize(strip, Math.max(1, Math.floor(strip.w / 12)), Math.max(1, Math.floor(strip.h / 12)), 'area');
  let lit = 0;
  for (let i = 0; i < cells.w * cells.h; i++) {
    const j = i * 3;
    if (Math.min(cells.data[j], cells.data[j + 1], cells.data[j + 2]) > 200) lit++;
  }
  return round(lit / (cells.w * cells.h), 3);
}

// ---- the scorestreak points counter ----

/** counter_masks: strict and relative masks of the counter's white digits. */
export function counterMasks(box, P) {
  const { w, h, c, data: D } = box, [ft, fb, fl, fr] = P.counter_inner;
  const y1 = Math.round(ft * h), y2 = Math.round(fb * h), x1 = Math.round(fl * w), x2 = Math.round(fr * w);
  const luma = [];
  for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const j = (y * w + x) * c; luma.push((D[j] + D[j + 1] + D[j + 2]) / 3); }
  const middle = median(luma), low = percentile(luma, 20), strict = new Uint8Array(w * h), relative = new Uint8Array(w * h);
  for (let y = y1; y < y2; y++) {
    for (let x = x1; x < x2; x++) {
      const j = (y * w + x) * c, l = (D[j] + D[j + 1] + D[j + 2]) / 3;
      const spread = Math.max(D[j], D[j + 1], D[j + 2]) - Math.min(D[j], D[j + 1], D[j + 2]);
      strict[y * w + x] = l > middle + 45 && spread < 60 && l > 150 ? 1 : 0;
      relative[y * w + x] = l > low + 50 && spread < 80 && l > 100 ? 1 : 0;
    }
  }
  // The box's edges (long horizontal runs) can touch the digits' tops.
  for (const m of [strict, relative]) dropLongRuns(m, w, y1, y2, x1, x2, 24);
  return [strict, relative];
}

/** counter_glyphs: digit crops left to right; `.ratio` is the single digits' median width / height. */
export function counterGlyphs(mask, w, h) {
  const all = components(mask, w, h);
  let parts = all.map((s, i) => ({ ...s, id: i + 1 })).filter((s) => s.h >= 6 && s.area >= 6).sort((a, b) => a.x - b.x);
  const tall = parts.filter((s) => s.h >= 14 && s.h <= 30);
  if (tall.length) {
    const top = median(tall.map((s) => s.y)), bottom = median(tall.map((s) => s.y + s.h));
    parts = parts.filter((s) => s.y + s.h > top + 2 && s.y < bottom - 2);
  }
  const ids = new Set(parts.map((s) => s.id)), keep = new Uint8Array(w * h);
  for (let i = 0; i < keep.length; i++) if (ids.has(all.labels[i])) keep[i] = 1;
  const merged = [];
  for (const s of parts) {
    const last = merged[merged.length - 1];
    if (last && s.x <= last.x + last.w - 1) {
      const y1 = Math.min(last.y, s.y), y2 = Math.max(last.y + last.h, s.y + s.h), x2 = Math.max(last.x + last.w, s.x + s.w);
      Object.assign(last, { y: y1, w: x2 - last.x, h: y2 - y1, area: last.area + s.area });
    } else merged.push({ ...s });
  }
  const singles = merged.filter((s) => s.h >= 14 && s.h <= 30 && s.w >= .45 * s.h && s.w <= .95 * s.h);
  const ratio = singles.length ? median(singles.map((s) => s.w / s.h)) : null;
  const out = [];
  for (const { x, y, w: bw, h: bh, area } of merged) {
    if (!(bh >= 14 && bh <= 30 && bw >= 2 && bw <= 48 && area >= 15)) continue;
    const pitch = singles.length ? median(singles.map((s) => s.w)) + 2 : .7 * bh;
    const pieces = Math.max(1, Math.floor(bw / pitch + .5));
    for (let k = 0; k < pieces; k++) {
      const x1 = x + Math.floor(k * bw / pieces), x2 = x + Math.floor((k + 1) * bw / pieces), gw = x2 - x1;
      const crop = { w: gw, h: bh, c: 1, data: new Float32Array(gw * bh) };
      for (let r = 0; r < bh; r++) for (let q = 0; q < gw; q++) crop.data[r * gw + q] = keep[(y + r) * w + x1 + q];
      out.push(resize(crop, 12, 20, 'area'));
    }
  }
  out.ratio = ratio;
  return out;
}

/** read_counter: [value, weakest digit match] or [null, 0]. */
export function readCounter(box, P) {
  let best = null, bestKey = [0, 0, 0];
  const above = (a, b) => a[0] !== b[0] ? a[0] > b[0] : a[1] !== b[1] ? a[1] > b[1] : a[2] > b[2];
  for (const mask of counterMasks(box, P)) {
    const glyphs = counterGlyphs(mask, box.w, box.h);
    if (!glyphs.length || glyphs.length > 4) continue;
    // One template set per reading: the one whose digit width is nearest this reading's, or each in turn.
    const fonts = P.counter_fonts, sets = [];
    if (glyphs.ratio == null) for (let start = 0; start < P.counter_digits.length; start += 10) sets.push(start);
    else {
      const gaps = fonts.map((f) => Math.abs(glyphs.ratio - f));
      sets.push(10 * gaps.indexOf(Math.min(...gaps)));
    }
    for (const start of sets) {
      const set = P.counter_digits.slice(start, start + 10);
      let value = 0, worst = 1;
      for (const g of glyphs) {
        const scores = set.map((t) => matchTemplateBest(g, t).score);
        const d = scores.indexOf(Math.max(...scores));
        value = value * 10 + d; worst = Math.min(worst, scores[d]);
        if (glyphs.length > 1 && value === 0) worst = 0;
      }
      const sure = worst >= P.counter_conf, key = [sure ? 1 : 0, sure ? glyphs.length : 0, worst];
      if (worst > 0 && above(key, bestKey)) { best = value; bestKey = key; }
    }
  }
  return [best, round(bestKey[2], 3)];
}

/** counter_candidates: places in the lower canvas where a counter-like number reads well: [{x, y, h, value}]. */
export function counterCandidates(full, P, most) {
  const { w: W, h: H, c, data: D } = full, [bx0, by0, bx1, by1] = P.counter_band;
  const X0 = Math.floor(W * bx0), Y0 = Math.floor(H * by0), X1 = Math.floor(W * bx1), Y1 = Math.floor(H * by1);
  const bw = X1 - X0, bh = Y1 - Y0, mask = new Uint8Array(bw * bh);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const j = ((Y0 + y) * W + X0 + x) * c, r = D[j], g = D[j + 1], b = D[j + 2];
      mask[y * bw + x] = Math.max(r, g, b) - Math.min(r, g, b) < 60 && r + g + b > 450 ? 1 : 0;
    }
  }
  const parts = components(mask, bw, bh).filter((s) => s.h >= 14 && s.h <= 30 && s.w >= 2 && s.w <= 48 && s.area >= 15)
    .sort((a, b) => a.x - b.x || a.y - b.y);
  const groups = [];
  for (const s of parts) {
    const mid = s.y + s.h / 2;
    const g = groups.find((g) => {
      const l = g[g.length - 1], gap = s.x - (l.x + l.w);
      return gap >= -2 && gap <= 10 && Math.abs(mid - (l.y + l.h / 2)) <= 4 && Math.abs(s.h - l.h) <= 5;
    });
    if (g) g.push(s); else groups.push([s]);
  }
  const out = [];
  for (const g of groups) {
    if (g.length > 4) continue;
    const x = X0 + (Math.min(...g.map((s) => s.x)) + Math.max(...g.map((s) => s.x + s.w))) / 2;
    const y = Y0 + (Math.min(...g.map((s) => s.y)) + Math.max(...g.map((s) => s.y + s.h))) / 2;
    const h = Math.max(...g.map((s) => s.h));
    const w2 = P.counter_size[0] * h / P.counter_digit / 2, h2 = P.counter_size[1] * h / P.counter_digit / 2;
    const xa = Math.max(0, Math.trunc(x - w2)), xb = Math.min(W, Math.trunc(x + w2));
    const ya = Math.max(0, Math.trunc(y - h2)), yb = Math.min(H, Math.trunc(y + h2));
    const box = { w: xb - xa, h: yb - ya, c, data: new Uint8Array((xb - xa) * (yb - ya) * c) };
    for (let r = 0; r < box.h; r++) box.data.set(D.subarray(((ya + r) * W + xa) * c, ((ya + r) * W + xb) * c), r * box.w * c);
    const [value, worst] = readCounter(box, P);
    if (value != null && value >= 10 && worst >= P.counter_conf && value <= most) out.push({ x, y, h, value });
  }
  return out;
}

/** counter_box: where the points counter is: {counter, icons, counter_frames}. */
export function counterBox(numbers, width, height, samples, P, share = .1) {
  let best = null;
  for (const a of numbers) {
    const near = numbers.filter((b) => Math.abs(b.x - a.x) <= 20 && Math.abs(b.y - a.y) <= 10);
    const frames = new Set(near.map((b) => b.frame)).size;
    if (!best || frames > best[0]) best = [frames, near];
  }
  if (!best || best[0] < Math.max(3, share * samples)) return { counter: null, icons: false };
  const near = best[1];
  const x = median(near.map((b) => b.x)), y = median(near.map((b) => b.y));
  const scale = median(near.map((b) => b.h)) / P.counter_digit;
  const w = P.counter_size[0] * scale, h = P.counter_size[1] * scale;
  const roi = [round(Math.max(0, (x - w / 2) / width), 4), round(Math.max(0, (y - h / 2) / height), 4),
    round(Math.min(1, (x + w / 2) / width), 4), round(Math.min(1, (y + h / 2) / height), 4)];
  const [r0, r1, r2, r3] = P.counter_roi, rx = (r0 + r2) / 2 * width, ry = (r1 + r3) / 2 * height;
  const icons = Math.abs(x - rx) <= 25 && Math.abs(y - ry) <= 15 && Math.abs(scale - 1) <= .1;
  return { counter: icons ? [...P.counter_roi] : roi, icons, counter_frames: best[0] };
}

/** popup_mask: the score popup number's saturated yellow (not its pale glow, not orange scenery). */
export function popupMask(box) {
  const { w, h, c, data: D } = box, mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const R = D[i * c], G = D[i * c + 1], B = D[i * c + 2], lo = Math.min(R, G);
    mask[i] = lo - B > 100 && lo > 120 && Math.abs(R - G) < 60 ? 1 : 0;
  }
  return mask;
}

/** popup_glyphs: the popup's characters left to right ('+' then digits), sized by the tallest piece. */
export function popupGlyphs(mask, w, h) {
  let parts = components(mask, w, h).filter((s) => s.area >= 8).sort((a, b) => a.x - b.x);
  if (!parts.length) return [];
  const tall = Math.max(...parts.map((s) => s.h));
  if (tall < 14 || tall > 70) return [];
  const bottom = Math.max(...parts.map((s) => s.y + s.h));
  parts = parts.filter((s) => s.h >= .35 * tall && s.y + s.h >= bottom - .5 * tall);
  const merged = [];
  for (const s of parts) {
    const last = merged[merged.length - 1];
    if (last && s.x <= last.x + last.w - 1) {
      const y1 = Math.min(last.y, s.y), y2 = Math.max(last.y + last.h, s.y + s.h), x2 = Math.max(last.x + last.w, s.x + s.w);
      Object.assign(last, { y: y1, w: x2 - last.x, h: y2 - y1, area: last.area + s.area });
    } else merged.push({ ...s });
  }
  const out = [], width = .62 * tall;
  for (const { x, y, w: bw, h: bh } of merged) {
    const pieces = bw > 1.4 * width ? Math.max(1, Math.floor(bw / width + .5)) : 1;
    for (let k = 0; k < pieces; k++) {
      const x1 = x + Math.floor(k * bw / pieces), x2 = x + Math.floor((k + 1) * bw / pieces), gw = x2 - x1;
      const crop = { w: gw, h: bh, c: 1, data: new Float32Array(gw * bh) };
      for (let r = 0; r < bh; r++) for (let q = 0; q < gw; q++) crop.data[r * gw + q] = mask[(y + r) * w + x1 + q];
      out.push(resize(crop, 12, 20, 'area'));
    }
  }
  return out;
}

const flat = (t) => { let lo = Infinity, hi = -Infinity; for (const v of t.data) { if (v < lo) lo = v; if (v > hi) hi = v; } return hi <= lo; };

/** read_popup: the popup's "+N" and the weakest character match, or [null, 0] (P.popup_digits[10] is '+'). */
export function readPopup(box, P) {
  const glyphs = popupGlyphs(popupMask(box), box.w, box.h);
  if (glyphs.length < 2 || glyphs.length > 4) return [null, 0];
  const scores = glyphs.map((g) => P.popup_digits.map((t) => (flat(t) ? -1 : matchTemplateBest(g, t).score)));
  if (scores[0].indexOf(Math.max(...scores[0])) !== 10) return [null, 0];
  let value = 0, worst = scores[0][10];
  for (const sc of scores.slice(1)) {
    const digits = sc.slice(0, 10), d = digits.indexOf(Math.max(...digits));
    value = value * 10 + d; worst = Math.min(worst, sc[d]);
  }
  return [value, round(worst, 3)];
}

/** icon_slots: the streak icons above the HP bar, cheapest streak first (the rightmost). */
export function iconSlots(count, P) {
  const [x1, y1, x2, y2] = P.icon_slot;
  return Array.from({ length: count }, (_, k) => [x1 - k * P.icon_pitch, y1, x2 - k * P.icon_pitch, y2]);
}

/** icon_lit: share of a slot's pixels in the yellow of a ready streak. */
export function iconLit(img) {
  const { c, data: D } = img, n = img.w * img.h;
  let lit = 0;
  for (let i = 0; i < n; i++) {
    const R = D[i * c], G = D[i * c + 1], B = D[i * c + 2], lo = Math.min(R, G);
    if (lo - B > 60 && Math.abs(R - G) < 40 && lo > 130) lit++;
  }
  return round(lit / n, 3);
}

/** read_sample: the reading and compact killfeed data; `frame.crop` gives each region on its canvas. */
export function readLive(frame, t, feed, P) {
  const box = frame.crop(feed.box), { w, h } = box;
  const { gold, red, light, redness } = colours(box);
  let reds = 0, golden = 0;
  const near = new Uint8Array(gold.length);
  for (let i = 0; i < gold.length; i++) { reds += red[i]; golden += gold[i]; near[i] = gold[i] | light[i]; }
  const rows = goldBands(near, w, h), sig = rows.length ? halfSize(redness, w, h) : new Uint8Array(0);
  const reading = {
    time: round(t, 3),
    killcam: titleScore(frame.crop(P.killcam_roi), P.titles.killcam, P),
    killed_by: titleScore(frame.crop(P.killed_by_roi), P.titles.killed_by, P),
    spectate: spectateScore(frame.crop(P.spectate_roi)),
    blank: reds / gold.length < .002 && golden / gold.length < .002,
  };
  // Where calibration found the counter (a feed from before it was looked for: the reference place).
  const counter = feed.counter === undefined ? P.counter_roi : feed.counter;
  [reading.points, reading.points_match] = counter ? readCounter(frame.crop(counter), P) : [null, 0];
  if (feed.icons !== false) reading.icons = iconSlots(P.streaks.costs.length, P).map((roi) => iconLit(frame.crop(roi)));
  [reading.popup, reading.popup_match] = readPopup(frame.crop(P.popup_roi), P);
  return { reading, sample: { gold: pack(gold), light: pack(light), rows: Int32Array.from(rows), sig }, shape: [h, w] };
}

/** The regions a live scan reads, grouped by the canvas they are read on. */
export function liveRegions(feed, P) {
  const counter = feed.counter === undefined ? P.counter_roi : feed.counter;
  return [
    { canvas: feed.feed_canvas, regions: [feed.box] },
    { canvas: feed.canvas, regions: [P.killcam_roi] },
    { canvas: feed.canvas, regions: [P.popup_roi] },
    {
      canvas: feed.canvas,
      regions: [P.killed_by_roi, P.spectate_roi, ...(counter ? [counter] : []),
        ...(feed.icons !== false ? iconSlots(P.streaks.costs.length, P) : [])],
    },
  ];
}

/** half_size: 2 x 2 means of a w x h byte image, rounded half up (odd last row/column dropped). */
export function halfSize(img, w, h) {
  const W = w >> 1, H = h >> 1, out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = 2 * y * w + 2 * x;
      out[y * W + x] = (img[i] + img[i + 1] + img[i + w] + img[i + w + 1] + 2) >> 2;
    }
  }
  return out;
}

function pack(bits) {
  const out = new Uint8Array(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 128 >> (i & 7);
  return out;
}

function unpack(packed, h, w) {
  const out = new Float32Array(h * w);
  for (let i = 0; i < out.length; i++) out[i] = (packed[i >> 3] >> (7 - (i & 7))) & 1;
  return { w, h, c: 1, data: out };
}

// ---- template matching (cv2.TM_CCOEFF_NORMED) ----

/**
 * Full TM_CCOEFF_NORMED map of `templ` over `area`. With `binary` and a `threshold`, windows that
 * cannot reach the threshold are skipped (left at -1); scores at or above it are unchanged.
 */
export function matchTemplate(area, templ, { x0 = 0, x1 = area.w, binary = false, threshold = -Infinity, rows = null } = {}) {
  const W = x1 - x0, H = area.h, { w, h } = templ, A = area.data, AW = area.w, n = w * h;
  const RW = W - w + 1, RH = H - h + 1;
  const out = new Float32Array(Math.max(RW, 0) * Math.max(RH, 0)).fill(-1);
  if (RW <= 0 || RH <= 0) return { w: Math.max(RW, 0), h: Math.max(RH, 0), data: out };
  let tmean = 0;
  for (const v of templ.data) tmean += v;
  tmean /= n;
  const T = new Float64Array(n);
  let tnorm = 0;
  for (let i = 0; i < n; i++) { T[i] = templ.data[i] - tmean; tnorm += T[i] * T[i]; }
  tnorm = Math.sqrt(tnorm);
  let bound = null;
  if (binary && threshold > -Infinity) {
    const sorted = Float64Array.from(T).sort().reverse();
    bound = new Float64Array(n + 1);   // bound[0] = 0: an empty window scores 0 (flat-window rule)
    for (let k = 1, s = 0; k <= n; k++) {
      s += sorted[k - 1];
      const sd = Math.sqrt(Math.max(k - k * k / n, 0)) * tnorm;
      bound[k] = sd > 0 ? s / sd : 1;
    }
  }
  const sum = new Float64Array((W + 1) * (H + 1)), sq = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = A[y * AW + x0 + x], i = (y + 1) * (W + 1) + x + 1;
    sum[i] = v + sum[i - 1] + sum[i - W - 1] - sum[i - W - 2];
    sq[i] = v * v + sq[i - 1] + sq[i - W - 1] - sq[i - W - 2];
  }
  const box = (I, x, y) => I[(y + h) * (W + 1) + x + w] - I[y * (W + 1) + x + w] - I[(y + h) * (W + 1) + x] + I[y * (W + 1) + x];
  // 0/1 area: each row's ones (x positions) and running count, so a window's ones are found directly.
  let ones = null, count = null, top = null;
  if (binary) {
    ones = []; count = [];
    for (let y = 0; y < H; y++) {
      const xs = [], c = new Int32Array(W + 1);
      for (let x = 0; x < W; x++) {
        c[x + 1] = c[x];
        if (A[y * AW + x0 + x]) { xs.push(x); c[x + 1]++; }
      }
      ones.push(xs); count.push(c);
    }
    // top[ty][k]: the largest sum k ones can take from template row ty (an exact ceiling for pruning).
    if (bound) {
      top = [];
      for (let ty = 0; ty < h; ty++) {
        const sorted = Float64Array.from(T.subarray(ty * w, (ty + 1) * w)).sort().reverse(), t = new Float64Array(w + 1);
        for (let k = 1; k <= w; k++) t[k] = t[k - 1] + sorted[k - 1];
        top.push(t);
      }
    }
  }
  for (let y = 0; y < RH; y++) {
    if (rows && !rows[y]) continue;
    for (let x = 0; x < RW; x++) {
      const s = box(sum, x, y);
      if (bound && bound[Math.round(s)] < threshold - 1e-6) continue;
      let num = 0;
      if (binary) {
        if (top) {
          const sd = Math.sqrt(Math.max(s - s * s / n, 0)) * tnorm;
          if (sd > 0) {
            let most = 0;
            for (let ty = 0; ty < h; ty++) { const c = count[y + ty]; most += top[ty][c[x + w] - c[x]]; }
            if (most / sd < threshold - 1e-6) continue;
          }
        }
        // Same order as summing every one into its windows: template rows, then ones left to right.
        for (let ty = 0; ty < h; ty++) {
          const xs = ones[y + ty], c = count[y + ty], trow = ty * w - x;
          for (let k = c[x], end = c[x + w]; k < end; k++) num += T[trow + xs[k]];
        }
      } else {
        for (let ty = 0; ty < h; ty++) {
          const row = (y + ty) * AW + x0 + x, trow = ty * w;
          for (let tx = 0; tx < w; tx++) num += A[row + tx] * T[trow + tx];
        }
      }
      const variance = Math.max(box(sq, x, y) - s * s / n, 0);
      const t = Math.sqrt(variance) * tnorm;
      let score;
      if (Math.abs(num) < t) score = num / t;
      else if (Math.abs(num) < t * 1.125) score = num > 0 ? 1 : -1;
      else score = 0;
      out[y * RW + x] = score;
    }
  }
  return { w: RW, h: RH, data: out };
}

const rowMax = (m, y) => { let b = -Infinity; for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x] > b) b = m.data[y * m.w + x]; return b; };
const rowArgmax = (m, y) => { let b = -Infinity, i = 0; for (let x = 0; x < m.w; x++) if (m.data[y * m.w + x] > b) { b = m.data[y * m.w + x]; i = x; } return i; };

// ---- the followed player's name ----

function letters(word, minLetters = 4) {
  const comps = components(Uint8Array.from(word.data), word.w, word.h);
  let ok = 0, okArea = 0, all = 0;
  for (const s of comps) {
    all += s.area;
    if (s.h >= 7 && s.h <= 20 && s.w <= 22 && s.w >= 2) { ok++; okArea += s.area; }
  }
  return ok >= minLetters && okArea >= .7 * all;
}

function textCrops(gold, x0, x1) {
  const { w, h, data } = gold, X1 = Math.min(x1, w), out = [];
  const profile = new Float64Array(h);
  for (let y = 0; y < h; y++) for (let x = x0; x < X1; x++) profile[y] += data[y * w + x];
  let y = 12;
  while (y < h - 12) {
    if (profile[y] >= 6) {
      let y2 = y;
      while (y2 + 1 < h && profile[y2 + 1] >= 6) y2++;
      const c = (y + y2) >> 1;
      if (y2 - y + 1 >= 8 && y2 - y + 1 <= 26 && c >= 12 && c < h - 12) {
        let first = -1;
        for (let x = x0; x < X1 && first < 0; x++) {
          let s = 0;
          for (let r = c - 12; r < c + 12; r++) s += data[r * w + x];
          if (s >= 2) first = x;
        }
        if (first >= 0) {
          const start = first - 3;
          if (start + 190 <= w) {
            const word = { w: 190, h: 24, c: 1, data: new Float32Array(190 * 24) };
            let mean = 0;
            for (let r = 0; r < 24; r++) for (let x = 0; x < 190; x++) {
              const v = data[(c - 12 + r) * w + start + x];
              word.data[r * 190 + x] = v; mean += v;
            }
            mean /= 190 * 24;
            if (mean > .05 && mean < .3 && letters(word)) out.push(word);
          }
        }
      }
      y = y2 + 1;
    } else y++;
  }
  return out;
}

function meanOf(images) {
  const { w, h } = images[0], out = { w, h, c: 1, data: new Float32Array(w * h) };
  for (const im of images) for (let i = 0; i < out.data.length; i++) out.data[i] += im.data[i] / images.length;
  return out;
}

function trim(t, gap = 8) {
  const ink = [];
  for (let x = 0; x < t.w; x++) { let m = -Infinity; for (let y = 0; y < t.h; y++) m = Math.max(m, t.data[y * t.w + x]); ink.push(m > .3); }
  const runs = [];
  let x = 0;
  while (x < ink.length) {
    if (ink[x]) {
      let x2 = x, blank = 0;
      while (x2 + 1 < ink.length && blank < gap) { x2++; blank = ink[x2] ? 0 : blank + 1; }
      runs.push([x, x2 - blank]); x = x2 + 1;
    } else x++;
  }
  const [a, b] = runs.reduce((p, r) => (r[1] - r[0] > p[1] - p[0] ? r : p));
  const rows = [];
  for (let y = 0; y < t.h; y++) { let m = -Infinity; for (let xx = a; xx <= b; xx++) m = Math.max(m, t.data[y * t.w + xx]); if (m > .3) rows.push(y); }
  const y0 = rows[0], y1 = rows[rows.length - 1], W = b - a + 1, H = y1 - y0 + 1;
  const out = { w: W, h: H, c: 1, data: new Float32Array(W * H) };
  for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) out.data[y * W + xx] = t.data[(y0 + y) * t.w + a + xx];
  return out;
}

/**
 * One sample's share of name_matches ({type: 'name'}) or follow_feed ({type: 'rows'}).
 * Run here, or spread over analyse-worker.js by worker.js; `map(indices, job)` runs it on each index.
 */
export function sampleWork(data, i, job) {
  const [h, w] = data.shape, sample = data.samples[i];
  if (job.type === 'name') return sampleNameMatches(sample, h, w, job.template, job.collect, job.side);
  const masks = [unpack(sample.gold, h, w), sample.light ? unpack(sample.light, h, w) : { w, h, c: 1, data: new Float32Array(h * w) }];
  return [killRows(masks, sample, job.template), deathRows(masks, sample, job.template)];
}

const runHere = (data) => async (indices, job) => indices.map((i) => sampleWork(data, i, job));

/** name_matches: confident name-template matches in every `step`-th sample: their count, or the crops when `collect`. */
async function nameMatches(data, template, step, collect = false, side = 2, map = runHere(data)) {
  const indices = [];
  for (let i = 0; i < data.samples.length; i += step) if (data.samples[i].rows.length) indices.push(i);
  const each = await map(indices, { type: 'name', template, collect, side });
  return collect ? each.flat() : each.reduce((a, b) => a + b, 0);
}

function sampleNameMatches(sample, h, w, template, collect, side) {
  const found = [];
  let count = 0;
  const gold = unpack(sample.gold, h, w);
  const result = matchTemplate(gold, template, { binary: true, threshold: .6, rows: bandRows(sample, h, template.h) });
  for (let k = 0; k < 4; k++) {
    let best = -Infinity, at = 0;
    for (let j = 0; j < result.data.length; j++) if (result.data[j] > best) { best = result.data[j]; at = j; }
    if (best < .6) break;
    count++;
    const y = Math.floor(at / result.w), x = at - y * result.w;
    if (collect && y >= 2 && y + template.h + 2 <= h) {
      const W2 = template.w + 2 * side, H2 = template.h + 4, m = { w: W2, h: H2, c: 1, data: new Float32Array(W2 * H2) };
      for (let r = 0; r < H2; r++) for (let cc = 0; cc < W2; cc++) {
        const xx = x - side + cc;
        if (xx >= 0 && xx < w) m.data[r * W2 + cc] = gold.data[(y - 2 + r) * w + xx];
      }
      found.push(m);
    }
    for (let r = Math.max(0, y - 15); r < Math.min(result.h, y + 15); r++) result.data.fill(-1, r * result.w, (r + 1) * result.w);
  }
  return collect ? found : count;
}

/** contains: whether `small` is (roughly) a piece of `big`. */
function contains(big, small) {
  if (small.h > big.h || small.w > big.w) return false;
  return matchTemplateBest(big, small).score > .6;
}

/** learn_name: the commonest gold killfeed word that matches the most rows. */
export async function learnName(data, map = runHere(data), step = 2, candidates = 5, check = 6) {
  const [h, w] = data.shape, n = data.samples.length;
  let crops = [];
  for (let i = 0; i < n; i += step) {
    const gold = unpack(data.samples[i].gold, h, w);
    crops.push(...textCrops(gold, 4, 60), ...textCrops(gold, 150, w - 40));
  }
  if (crops.length < 3) throw new Error("The followed player's name never shows in the killfeed; no kills or deaths to read.");
  const flat = crops.map((c) => {
    let m = 0;
    for (const v of c.data) m += v;
    m /= c.data.length;
    const f = new Float64Array(c.data.length);
    let norm = 0;
    for (let i = 0; i < f.length; i++) { f[i] = c.data[i] - m; norm += f[i] * f[i]; }
    norm = Math.sqrt(norm) + 1e-6;
    for (let i = 0; i < f.length; i++) f[i] /= norm;
    return f;
  });
  const dot = (A, B) => { let s = 0; for (let i = 0; i < A.length; i++) s += A[i] * B[i]; return s; };
  const support = new Int32Array(crops.length);
  for (let a = 0; a < crops.length; a++) for (let b = a; b < crops.length; b++) {
    if (dot(flat[a], flat[b]) > .75) { support[a]++; if (b !== a) support[b]++; }
  }
  const order = [...support.keys()].sort((a, b) => support[b] - support[a] || a - b), seeds = [];
  for (const k of order) {
    if (seeds.length === candidates) break;
    if (!seeds.some((j) => dot(flat[k], flat[j]) > .75)) seeds.push(k);
  }
  const found = await Promise.all(seeds.map(async (seed) => {
    let template = crops[seed];
    for (let k = 0; k < 4; k++) template = meanOf(crops.filter((c) => matchTemplateBest(c, template).score > .6));
    template = trim(template);
    return [template, await nameMatches(data, template, check, false, 2, map)];
  }));
  const totals = found.map(([big]) => found.reduce((a, [t, hits]) => a + (t === big || contains(big, t) ? hits : 0), 0));
  let template = found[totals.indexOf(Math.max(...totals))][0];
  const wide = await nameMatches(data, template, step, true, 40, map);
  if (wide.length >= 3) template = trim(meanOf(wide));
  const matches = await nameMatches(data, template, step, true, 2, map);
  return matches.length >= 3 ? trim(meanOf(matches)) : template;
}

// ---- following killfeed rows ----

/** band_rows: template positions y whose row band (centre y + th//2, +-12 rows) was kept. */
function bandRows(sample, height, th, half = 12) {
  const kept = new Int32Array(height + 1);
  for (const r of sample.rows) kept[r + 1] = 1;
  for (let k = 1; k <= height; k++) kept[k] += kept[k - 1];
  const out = new Uint8Array(Math.max(height - th + 1, 0));
  for (let y = 0; y < out.length; y++) {
    const c = y + (th >> 1);
    out[y] = c - half >= 0 && c + half <= height && kept[c + half] - kept[c - half] === 2 * half ? 1 : 0;
  }
  return out;
}

/** band: rows c-12..c+12, columns x1..x2 of the half-size signature, or null when not kept. */
function band(sample, key, w, h, c, x1 = 0, x2 = w, half = 12) {
  const rows = sample.rows;
  let at = 0;
  while (at < rows.length && rows[at] < c - half) at++;
  if (at + 2 * half > rows.length || rows[at] !== c - half || rows[at + 2 * half - 1] !== c + half - 1) return null;
  const hw = w >> 1, hh = h >> 1, top = (c - half) >> 1;
  if (top + half > hh) return null;
  const X1 = Math.min(hw, x1 >> 1), X2 = Math.min(hw, x2 >> 1), W = Math.max(X2 - X1, 0);
  const out = { w: W, h: half, c: 1, data: new Float32Array(W * half) };
  const src = sample[key];
  for (let r = 0; r < half; r++) for (let x = 0; x < W; x++) out.data[r * W + x] = src[(top + r) * hw + X1 + x];
  return out;
}

function std(img) {
  let m = 0;
  for (const v of img.data) m += v;
  m /= img.data.length;
  let s = 0;
  for (const v of img.data) s += (v - m) ** 2;
  return Math.sqrt(s / img.data.length);
}

function sub(img, x0, y0, w, h) {
  const out = { w, h, c: 1, data: new Float32Array(w * h) };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out.data[y * w + x] = img.data[(y0 + y) * img.w + x0 + x];
  return out;
}

/** patch_similarity: best correlation of b's centre (shifted up to 4 px) inside a. */
export function patchSimilarity(a, b) {
  if (!a || !b) return 0;
  const w = Math.min(a.w, b.w) - 4;
  if (w < 10) return 0;
  const inner = sub(b, 2, 2, w, b.h - 4);
  if (std(a) < 3 || std(inner) < 3) return 0;
  return matchTemplateBest(sub(a, 0, 0, w + 4, a.h), inner).score;
}

function peaks(score, threshold, separation = 18) {
  const order = [...score.keys()].sort((a, b) => score[b] - score[a] || a - b);
  const found = [];
  for (const y of order) {
    if (score[y] < threshold) break;
    if (found.every((o) => Math.abs(y - o) >= separation)) found.push(y);
  }
  return found.sort((a, b) => a - b);
}

/** name_match: the name's match over the gold mask or, where it scores higher, the light mask. */
function nameMatch(masks, template, opts) {
  const [a, b] = masks.map((m) => matchTemplate(m, template, opts));
  for (let i = 0; i < a.data.length; i++) if (b.data[i] > a.data[i]) a.data[i] = b.data[i];
  return a;
}

function killRows(masks, sample, template, threshold = .55) {
  const { h: th, w: tw } = template, [gold] = masks;
  if (!sample.rows.length) return [];
  const m = nameMatch(masks, template, { x0: 4, x1: Math.min(gold.w, 4 + tw + 30), binary: true, threshold, rows: bandRows(sample, gold.h, th) });
  const score = Array.from({ length: m.h }, (_, y) => rowMax(m, y));
  const rows = [];
  for (const y of peaks(score, threshold)) {
    const c = y + (th >> 1), sig = band(sample, 'sig', gold.w, gold.h, c, 14 + tw + 4);
    if (sig) rows.push([c, sig, score[y]]);
  }
  return rows;
}

function deathRows(masks, sample, template, threshold = .55) {
  const { h: th } = template, [gold] = masks;
  if (!sample.rows.length) return [];
  const m = nameMatch(masks, template, { x0: 54, binary: true, threshold, rows: bandRows(sample, gold.h, th) });
  const score = Array.from({ length: m.h }, (_, y) => rowMax(m, y));
  const rows = [];
  for (const y of peaks(score, threshold)) {
    const c = y + (th >> 1), x = rowArgmax(m, y) + 54;
    if (x >= 120) {
      const sig = band(sample, 'sig', gold.w, gold.h, c, 10, x - 10);
      if (sig) rows.push([c, sub(sig, 0, 0, Math.min(55, sig.w), sig.h), score[y]]);
    }
  }
  return rows;
}

/** RowTracker: see live_analysis.RowTracker. */
export class RowTracker {
  constructor(pitch = 35, { lose = 1, hold = 2.5, memory = 10, same = .5, clean = .58, comeback = 1, keep = 4, confirm = 1 } = {}) {
    Object.assign(this, { pitch, lose, hold, memory, same, clean, comeback, keep, confirm });
    this.active = []; this.hidden = []; this.pending = []; this.events = [];
    this.backAt = -1e9; this.awayNow = false;
  }

  similarity(sig, row) {
    return Math.max(...row.sigs.map((s) => patchSimilarity(sig, s)));
  }

  away() {
    this.hidden.push(...this.active);
    this.active = []; this.pending = []; this.awayNow = true;
  }

  feed(t, detections) {
    if (this.awayNow) { this.backAt = t; this.awayNow = false; }
    this.hidden = this.hidden.filter((r) => t - r.t <= this.memory && t - this.backAt <= this.comeback);
    this.active = this.active.filter((r) => t - r.t <= this.hold);
    const pairs = [];
    detections.forEach(([y, sig], i) => {
      this.active.forEach((row, j) => {
        const samePlace = Math.abs(y - row.y) <= 8;
        const s = this.similarity(sig, row);
        // Unseen for over `lose` s: only the same place, or pushed down a slot and clearly the same row.
        if (t - row.t > this.lose && !samePlace && !(y > row.y + 8 && s >= .85)) return;
        if (y >= row.y - .6 * this.pitch && s >= this.same - (samePlace ? .15 : 0)) pairs.push([s, i, j]);
      });
    });
    pairs.sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2]);
    const usedD = new Set(), usedR = new Set();
    for (const [, i, j] of pairs) {
      if (usedD.has(i) || usedR.has(j)) continue;
      usedD.add(i); usedR.add(j);
      const row = this.active[j], [y, sig, score] = detections[i];
      row.y = y; row.t = t;
      if (score >= this.clean) row.sigs = [...row.sigs.slice(0, 1), ...row.sigs.slice(1).slice(-(this.keep - 2)), sig];
    }
    const unmatched = [];
    detections.forEach(([y, sig, score], i) => {
      if (usedD.has(i)) return;
      let back = null, best = -Infinity;
      for (const r of this.hidden) { const s = this.similarity(sig, r); if (s > best) { best = s; back = r; } }
      if (back && best >= .55) {
        this.hidden = this.hidden.filter((r) => r !== back);
        back.y = y; back.t = t;
        this.active.push(back);
      } else unmatched.push([y, sig, score]);
    });
    const fresh = [];
    for (const [y, sig, score] of unmatched) {
      const first = this.pending.find((p) => t - p.t <= this.confirm && Math.abs(y - p.y) <= this.pitch + 8
        && patchSimilarity(sig, p.sig) >= this.same);
      if (first) {
        this.pending = this.pending.filter((p) => p !== first);
        if (Math.max(first.score, score) >= this.clean) {
          this.events.push(first.first);
          this.active.push({ y, t, sigs: [score >= first.score ? sig : first.sig] });
          continue;
        }
      }
      fresh.push({ y, t, first: first ? first.first : t, sig, score: Math.max(score, first ? first.score : 0) });
    }
    this.pending = this.pending.filter((p) => t - p.t <= this.confirm).concat(fresh);
  }
}

export const isAway = (r, P) => r.killcam >= P.away_score || r.killed_by >= P.away_score || r.spectate >= P.spectate_lit;

/** follow_feed: times the followed player's kill rows and death rows first appear. */
export async function followFeed(scan, data, template, P, map = runHere(data)) {
  const kills = new RowTracker(scan.feed.read_pitch), deaths = new RowTracker(scan.feed.read_pitch);
  const away = (r) => isAway(r, P) || r.blank;
  const todo = scan.readings.flatMap((r, i) => (away(r) || !data.samples[i].rows.length ? [] : [i]));
  const found = await map(todo, { type: 'rows', template }), rows = new Map(todo.map((i, k) => [i, found[k]]));
  scan.readings.forEach((r, i) => {
    if (away(r)) { kills.away(); deaths.away(); return; }
    const [killed, died] = rows.get(i) ?? [[], []];
    kills.feed(r.time, killed);
    deaths.feed(r.time, died);
  });
  return { kills: kills.events, feedDeaths: deaths.events };
}

export function killcamStarts(readings, P) {
  const starts = [];
  let before = false;
  for (const r of readings) {
    const now = r.killcam >= P.away_score;
    if (now && !before) starts.push(r.time);
    before = now;
  }
  return starts;
}

/** death_times: killfeed deaths confirmed by killcams, plus either alone; none within 5 s of another. */
export function deathTimes(readings, feedDeaths, P, lag = 2.2) {
  const starts = killcamStarts(readings, P), times = [];
  for (const k of starts) {
    const near = feedDeaths.filter((f) => f >= k - 4.5 && f <= k);
    times.push(near.length ? near.reduce((a, f) => (Math.abs(k - lag - f) < Math.abs(k - lag - a) ? f : a)) : round(k - lag + .1, 3));
  }
  times.push(...feedDeaths.filter((f) => !starts.some((k) => k - f >= 0 && k - f <= 4.5)));
  const merged = [];
  for (const t of times.sort((a, b) => a - b)) if (!merged.length || t - merged[merged.length - 1] > 5) merged.push(t);
  return merged;
}

/** live_ranges: from each death until the player's own view is back, and every killcam / spectating stretch. */
export function liveRanges(readings, deaths, settle, P) {
  const ranges = [];
  let run = null;
  for (const r of [...readings, null]) {
    if (r && isAway(r, P)) {
      run = run || [r.time, r.time];
      run[1] = r.time;
    } else if (run) {
      ranges.push({ start: run[0], end: (r ? r.time : run[1]) + settle, cuts: [run[0]], away: true });
      run = null;
    }
  }
  for (const d of deaths) {
    const back = ranges.find((s) => s.away && s.start >= d && s.start - d <= 6);
    ranges.push({ start: d, end: back ? back.end : d + settle, cuts: [d], away: false });
  }
  return ranges;
}

// ---- kills from the points counter ----

const readable = (r, P) => r.points != null && (r.points_match || 0) >= P.counter_conf;

/** icon_unlocks: times each streak's icon lit up (unlit for `hold` readings, then lit for `hold`). */
export function iconUnlocks(readings, count, P, hold = 2) {
  const found = Array.from({ length: count }, () => []), state = new Array(count).fill(null), run = new Array(count).fill(null);
  for (const r of readings) {
    if (!r.icons || !r.icons.length || isAway(r, P)) continue;
    r.icons.slice(0, count).forEach((share, k) => {
      const now = share >= P.icon_lit;
      run[k] = run[k] && run[k][0] === now ? [now, run[k][1] + 1, run[k][2]] : [now, 1, r.time];
      if (run[k][1] === hold && state[k] !== now) {
        if (now && state[k] === false) found[k].push(run[k][2]);
        state[k] = now;
      }
    });
  }
  return found;
}

/** unread_for: for a time t, seconds since the counter was last read well before t (own view). */
function unreadFor(readings, P) {
  const seen = readings.filter((r) => !isAway(r, P) && readable(r, P)).map((r) => r.time);
  return (t) => {
    let lo = 0, hi = seen.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (seen[m] < t - 1e-6) lo = m + 1; else hi = m; }
    return lo ? t - seen[lo - 1] : Infinity;
  };
}

/** plausible: whether `gain` points in `dt` s can be real (a multi-kill at once, then about a kill a second). */
const plausible = (gain, dt, burst = 300, rate = 100) => gain <= burst + rate * dt;

/** counter_points: points earned in each life, [[time, points, life]] for each accepted value. */
export function counterPoints(readings, costs, P, hold = 2, undo = 5, settle = 1, streaks = false) {
  const unread = unreadFor(readings, P);
  let awayAt = null, run = [], died = false, reset = false, cam = false;
  const steady = [];
  for (const r of readings) {
    if (isAway(r, P)) {                // a killcam or spectating: a death
      cam = (cam && died) || r.killcam >= P.away_score || r.killed_by >= P.away_score;
      awayAt = r.time; run = []; died = true; reset = false; continue;
    }
    if (!readable(r, P) || r.points === 0) continue;   // never 0: a streak unlocks the moment its cost is reached
    reset = reset || (died && r.points === costs[0]);
    if (awayAt !== null && r.time - awayAt <= settle) continue;
    // a white flash, not a death
    if (died && !cam && !reset && steady.length && r.points <= steady[steady.length - 1][1]) died = false;
    run = run.length && run[run.length - 1][1] === r.points ? run.concat([[r.time, r.points]]) : [[r.time, r.points]];
    // A value that lost digits (219 then 19) counts only once it stays 2 s.
    const prev = steady.length ? steady[steady.length - 1][1] : null;
    const tail = prev !== null && !died && r.points < prev && String(prev).includes(String(r.points));
    if (run.length === (tail ? 8 : hold) && (prev === null || prev !== r.points || died)) {
      // the dead player's counter, still up until the respawn shows the reset
      if (died && !reset && steady.length && steady[steady.length - 1][1] === r.points) continue;
      steady.push([run[0][0], r.points, died]);
      died = false;
    }
  }
  const unlocks = iconUnlocks(readings, costs.length, P, 6);   // 1.5 s: a lighting icon glows into its neighbour briefly
  const take = (j, t) => {
    const i = (unlocks[j] || []).findIndex((u) => Math.abs(u - t) <= 1.5);
    if (i < 0) return false;
    unlocks[j].splice(i, 1);
    return true;
  };
  const out = [];   // [time, value, points, life, next streak]
  const litUnlocks = new Set();   // times of unlocks a streak icon lighting confirmed
  for (const [i, [t, v, respawned]] of steady.entries()) {
    // The last reading lost its leading digit (66 then 266): it was this value all along.
    while (!respawned && out.length > 1 && out[out.length - 1][3] === out[out.length - 2][3] && v > out[out.length - 1][1]
      && t - out[out.length - 1][0] < 1 && String(v).endsWith(String(out[out.length - 1][1]))) out.pop();
    if (!out.length) { out.push([t, v, costs[0] - v, 0, 0]); continue; }
    const [, last, earned, life, k] = out[out.length - 1];
    if (v === last && !respawned) continue;
    const dt = unread(t);   // misreads claiming more points than could be earned since the last reading are skipped
    if (respawned) {   // a new life starts at 0 points, before the first streak
      out.push([t, costs[0], 0, life + 1, 0]);
      if (v < costs[0] && plausible(costs[0] - v, 0)) out.push([t, v, costs[0] - v, life + 1, 0]);
    } else if (v < last) {
      // A fall can still be an unlock (151 -> 95 when 256 points pass the 500 streak): its icon lights.
      const next = steady[i + 1], rises = next && next[0] - t <= 2 && next[1] > v && !next[2];
      const lit = (unlocks[k] || []).some((u) => Math.abs(u - t) <= 1.5);
      if (lit && !rises && k + 1 < costs.length && costs[k + 1] - v >= costs[k] && plausible(costs[k + 1] - v - earned, dt)) {
        take(k, t);
        litUnlocks.add(t);
        out.push([t, v, costs[k + 1] - v, life, k + 1]);
      } else if (plausible(costs[k] - v - earned, dt)) out.push([t, v, costs[k] - v, life, k]);
    }
    else if (v === costs[0] && last !== costs[0]) out.push([t, v, 0, life + 1, 0]);
    else {
      let same = null;
      for (let i = out.length - 1; i >= 0 && out[i][3] === life && t - out[i][0] <= undo; i--) {
        if (out[i][1] === v) { same = i; break; }
      }
      if (same !== null) { out.length = same + 1; continue; }
      // An unlock leaves at least the unlocked streak's cost in points (500 misread as 580 does not).
      let unlocked = null;
      for (let k2 = k + 1; k2 < costs.length; k2++) if (costs[k2] - v >= Math.max(earned, costs[k2 - 1])) { unlocked = k2; break; }
      if (unlocked !== null && plausible(costs[unlocked] - v - earned, dt)) {
        for (let j = k; j < unlocked; j++) if (take(j, t)) litUnlocks.add(t);
        out.push([t, v, costs[unlocked] - v, life, unlocked]);
      }
    }
  }
  // With the streak and whether an icon confirmed reaching it, when `streaks`.
  return out.map(([t, , p, life, k]) => (streaks ? [t, p, life, k, litUnlocks.has(t)] : [t, p, life]));
}

/** counter_kills: each rise of a kill's points seen within `quick` s of the previous reading is a kill. */
export function counterKills(readings, streaks, P, slack = 15, quick = 2) {
  const found = [], unread = unreadFor(readings, P);
  let last = null;
  for (const [t, p, life, k, lit] of counterPoints(readings, streaks.costs, P, 2, 5, 1, true)) {
    // Unlock kills count only when a streak icon confirms them (streak costs vary per player).
    if (last && life === last[2] && (k === last[3] || lit) && unread(t) <= quick) {
      for (let n = Math.floor((p - last[1] + slack) / streaks.kill_points); n > 0; n--) found.push(t);
    }
    last = [t, p, life, k];
  }
  return found;
}

/** counter_readable: the counter reads in at least half of the own-view readings. */
export function counterReadable(readings, P, share = .5) {
  const own = readings.filter((r) => !(isAway(r, P) || r.blank));
  return own.length > 0 && own.filter((r) => readable(r, P)).length >= share * own.length;
}

/** counter_flickers: the counter keeps flipping (a value, another, the first again within 1 s): digits too
 * blurred to read, whose misreads would look like points earned. Readable recordings flip under 4 in 100. */
export function counterFlickers(readings, P, most = .08) {
  const own = readings.filter((r) => !(isAway(r, P) || r.blank) && readable(r, P));
  let flips = 0;
  for (let i = 2; i < own.length; i++) {
    const [a, b, c] = [own[i - 2], own[i - 1], own[i]];
    if (c.time - a.time <= 1.01 && a.points === c.points && b.points !== a.points) flips++;
  }
  return own.length > 0 && flips > most * own.length;
}

/** without_counter: the readings with the counter left out. */
export const withoutCounter = (readings) => readings.map((r) => ({ ...r, points: null, points_match: 0 }));

/** counter_steps: [time, points] for each rise of the counter's points within a life. */
export function counterSteps(readings, costs, P) {
  const pts = counterPoints(readings, costs, P), out = [];
  for (let i = 1; i < pts.length; i++) if (pts[i][2] === pts[i - 1][2] && pts[i][1] > pts[i - 1][1]) out.push([pts[i][0], pts[i][1] - pts[i - 1][1]]);
  return out;
}

/** popup_events: kills the score popup shows, [time, kills] (each ~100 rise within a popup). */
export function popupEvents(readings, P, gap = .75, hold = 2, step = 100, slack = 15) {
  const steady = [];
  let run = [], last = null;
  for (const r of readings) {
    if (isAway(r, P)) continue;
    const v = r.popup, match = r.popup_match || 0;
    if (v == null || match < P.popup_conf) continue;
    const t = r.time;
    if (last === null || t - last > gap) run = [];
    last = t;
    run = run.length && run[run.length - 1][1] === v ? run.concat([[t, v]]) : [[t, v]];
    if (run.length === hold || (run.length === 1 && v >= 85 && match >= P.popup_sure)) {
      const s = steady[steady.length - 1];
      if (!s || s[1] !== v || t - s[2] > gap) steady.push([run[0][0], v, t, run.length >= hold]);
    }
  }
  const out = [];
  let prev = null;
  for (const [t, v, seen, held] of steady) {
    const fresh = prev === null || t - prev[2] > gap;
    if (!fresh && v < prev[1]) { prev = [prev[0], prev[1], seen]; continue; }   // a misread inside the same popup
    const n = Math.floor((v - (fresh ? 0 : prev[1]) + slack) / step);
    if (n > 0) out.push([t, held ? n : 1]);
    prev = [t, v, seen];
  }
  return out;
}

/** last_gasp: kills the counter showed only in its last reading before a death. */
export function lastGasp(readings, deaths, P) {
  const out = [];
  for (const d of deaths) {
    const seen = readings.filter((r) => r.time >= d - 2.5 && r.time <= d + .5 && readable(r, P));
    if (seen.length < 2) continue;
    const last = seen[seen.length - 1].points, held = seen[seen.length - 2].points;
    if (last < held && held === seen[0].points && !String(held).endsWith(String(last))) {
      const n = Math.floor((held - last + 15) / 100);
      if (n > 0 && plausible(held - last, seen[seen.length - 1].time - seen[seen.length - 2].time)) out.push([seen[seen.length - 1].time, n]);
    }
  }
  return out;
}

/** fuse_kills: kills from the points counter, then the score popup, then the killfeed (see live_analysis.fuse_kills). */
export function fuseKills(readings, feed, deaths, streaks, P, lag = [-1.5, 3], near = 3) {
  const steps = counterSteps(readings, streaks.costs, P), popups = popupEvents(readings, P);
  // A multi-kill jump can be a lost digit (393 then 86): the popups and killfeed cap it.
  const raw = counterKills(readings, streaks, P), counter = [];
  for (const t of [...new Set(raw)].sort((a, b) => a - b)) {
    let n = raw.filter((x) => x === t).length;
    if (n > 1) {
      const within = (x) => x - t >= -2 && x - t <= 3;
      const seen = Math.max(popups.filter(([p]) => within(p)).reduce((s, [, m]) => s + m, 0), feed.filter(within).length);
      if (seen) n = Math.min(n, seen);
    }
    for (let i = 0; i < n; i++) counter.push(t);
  }
  const big = counter;   // popups the counter's kills explain (not its unlocks: see counterKills)
  const good = readings.filter((r) => readable(r, P) && !isAway(r, P)).map((r) => r.time);
  const readNear = (t, a, b) => good.some((g) => g >= t + a && g <= t + b);
  let kills = [...counter];
  for (const [t, n] of lastGasp(readings, deaths, P)) {
    if (!big.some((c) => Math.abs(t - c) <= 1)) for (let i = 0; i < n; i++) kills.push(t);
  }
  // Next to an unconfirmed unlock, each counter kill explains only one popup kill.
  const points = counterPoints(readings, streaks.costs, P, 2, 5, 1, true);
  const unlocks = points.slice(1).filter((p, i) => p[2] === points[i][2] && p[3] > points[i][3] && !p[4]).map((p) => p[0]);
  const spare = [...big], fromCounter = counter.length;
  for (const [t, n] of popups) {
    if (!unlocks.some((u) => t - u >= -near && t - u <= lag[1])) {
      const explained = big.some((c) => t - c >= lag[0] && t - c <= lag[1]);
      if (!explained && !kills.some((k) => Math.abs(t - k) <= near) && readNear(t, -5, 3)) for (let i = 0; i < n; i++) kills.push(t - .5);
      continue;
    }
    let unexplained = 0;
    for (let i = 0; i < n; i++) {
      const c = spare.findIndex((x) => t - x >= -near && t - x <= lag[1]);
      if (c < 0) unexplained++; else spare.splice(c, 1);
    }
    if (unexplained && !kills.slice(fromCounter).some((k) => Math.abs(t - k) <= near) && readNear(t, -5, 3)) {
      for (let i = 0; i < unexplained; i++) kills.push(t - .5);
    }
  }
  kills.sort((a, b) => a - b);
  const sortedFeed = [...feed].sort((a, b) => a - b), added = [];
  // A counter kill explains a killfeed row from 2 s before it to 3 s after.
  const sees = (f, k) => (counter.includes(k) ? f - k >= -2 && f - k <= 3 : Math.abs(f - k) <= near);
  const explainedRows = feed.filter((f) => kills.some((k) => sees(f, k)));
  for (const f of sortedFeed) {
    if (kills.some((k) => sees(f, k)) || added.some((k) => Math.abs(f - k) > 0 && Math.abs(f - k) <= 1)) continue;
    if (explainedRows.some((e) => f - e > 0 && f - e <= 4)) continue;   // the same row seen again as it moves down
    const small = steps.some(([t, p]) => Math.abs(t - f) <= 2.5 && p >= 20 && p < 85);
    const trade = deaths.some((d) => d - f >= -1 && d - f <= near);
    if (small || trade || !readNear(f, -2, 2)) added.push(f);
  }
  const used = new Set(), timed = [];
  for (const k of kills) {
    const i = sortedFeed.findIndex((x, j) => !used.has(j) && x >= k - 2 && x <= k + 1);
    if (i >= 0 && counter.includes(k)) { used.add(i); timed.push(sortedFeed[i]); } else timed.push(k);
  }
  return timed.concat(added).sort((a, b) => a - b);
}
