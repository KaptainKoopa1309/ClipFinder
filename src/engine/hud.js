// HUD reading, ported from counter.py and the pixel parts of video_analysis.py.
// A "frame" is anything with w, h and crop(roi) -> 8-bit RGB image (see video.js).
import {
  image, resize, minChannel, gray, toFloat, gaussian3, normalise, dot,
  matchTemplateBest, percentile, median, round,
} from './cv.js';

/** Loads hud-profile.json and its template files (relative to `base`). */
export async function loadProfile(base) {
  const get = (path) => fetch(new URL(path, base)).then((r) => {
    if (!r.ok) throw new Error(`Cannot load ${path}: ${r.status}`);
    return r;
  });
  const profile = await (await get('hud-profile.json')).json();
  const digits = new Uint8Array(await (await get(profile.digit_templates.file)).arrayBuffer());
  const combo = new Uint8Array(await (await get(profile.combo.word_template.file)).arrayBuffer());
  return { profile, digits, combo };
}

/** counter.glyphs: digit-shaped ink groups in the 130x180 tile, each resized to 24x48. */
function glyphs(ink, P) {
  const W = 180, H = 130, g = P.glyph;
  const columns = [];
  for (let x = 0; x < W; x++) {
    let s = 0;
    for (let y = 0; y < H; y++) s += ink[y * W + x];
    if (s > g.min_column_ink) columns.push(x);
  }
  const groups = [];
  for (const x of columns) {
    const last = groups[groups.length - 1];
    if (!last || x - last[last.length - 1] > g.max_column_gap) groups.push([x]);
    else last.push(x);
  }
  const result = [];
  for (const group of groups) {
    const left = group[0], right = group[group.length - 1] + 1;
    const ys = [];
    for (let y = 0; y < H; y++) {
      for (let x = left; x < right; x++) if (ink[y * W + x]) { ys.push(y); break; }
    }
    if (right - left < g.min_width || !ys.length || ys[ys.length - 1] - ys[0] < g.min_height) continue;
    const crop = image(right - left, ys[ys.length - 1] - ys[0] + 1, 1);
    for (let y = 0; y < crop.h; y++) for (let x = 0; x < crop.w; x++) {
      crop.data[y * crop.w + x] = ink[(y + ys[0]) * W + x + left];
    }
    result.push(resize(crop, g.size[0], g.size[1], 'area').data);
  }
  return result;
}

export class CounterReader {
  constructor(profile, digitBytes) {
    this.P = profile.counter;
    const t = profile.digit_templates;
    [this.n, this.th, this.tw] = t.shape;
    this.labels = Int8Array.from(t.labels);
    this.values = new Float32Array(digitBytes.length);
    for (let i = 0; i < digitBytes.length; i++) this.values[i] = digitBytes[i] / t.scale;
  }

  /** {count, similarity} when the digits read clearly, otherwise {} (CounterReader.read). */
  read(crop) {
    const P = this.P, [TW, TH] = P.tile.size, [RW, RH] = P.tile.resize, [ox, oy] = P.tile.offset;
    const m = minChannel(resize(crop, RW, RH)).data;
    // Tile of the white-on-dark digits as ink (1), inside a blank border, rows outside the ink band cleared.
    const ink = new Uint8Array(TW * TH);
    const [top, bottom] = P.glyph.ink_rows;
    for (let y = 0; y < RH; y++) {
      const ty = y + oy;
      if (ty < top || ty >= bottom) continue;
      for (let x = 0; x < RW; x++) ink[ty * TW + x + ox] = m[y * RW + x] > P.tile.threshold ? 1 : 0;
    }
    const digits = glyphs(ink, P);
    if (digits.length < 1 || digits.length > P.max_digits) return {};
    let text = '';
    const scores = [], margins = [];
    const size = this.th * this.tw;
    for (const digit of digits) {
      const perLabel = new Array(10).fill(Infinity);
      for (let t = 0; t < this.n; t++) {
        let e = 0;
        const base = t * size;
        for (let i = 0; i < size; i++) e += Math.abs(this.values[base + i] - digit[i]);
        e /= size;
        if (e < perLabel[this.labels[t]]) perLabel[this.labels[t]] = e;
      }
      const order = [...perLabel.keys()].sort((a, b) => perLabel[a] - perLabel[b]);
      text += order[0];
      scores.push(perLabel[order[0]]);
      margins.push(perLabel[order[1]] - perLabel[order[0]]);
    }
    if (Math.max(...scores) < P.max_score && Math.min(...margins) > P.min_margin) {
      return { count: parseInt(text, 10), similarity: round(1 - Math.max(...scores), 4) };
    }
    return {};
  }
}

/** Fraction of the HP bar's width that is lit (about 1 alive, about 0 dead). */
export function hpFill(band, level) {
  const m = minChannel(band);
  let lit = 0;
  for (let x = 0; x < m.w; x++) {
    let top = 0;
    for (let y = 0; y < m.h; y++) top = Math.max(top, m.data[y * m.w + x]);
    if (top > level) lit++;
  }
  return round(lit / m.w, 3);
}

function columnPeaks(band) {
  const m = minChannel(band), peaks = [];
  for (let x = 0; x < m.w; x++) {
    let top = 0;
    for (let y = 0; y < m.h; y++) top = Math.max(top, m.data[y * m.w + x]);
    peaks.push(top);
  }
  return peaks;
}

/** The spectated player's name sits left of the kill count in the same panel. */
export const nameRoi = (profile, counterRoi) => [profile.name.x_range[0], counterRoi[1], profile.name.x_range[1], counterRoi[3]];

export function nameMask(frame, roi, profile) {
  const [w, h] = profile.name.size;
  const m = minChannel(resize(frame.crop(roi), w, h)).data;
  return Uint8Array.from(m, (v) => (v > profile.name.mask_level ? 1 : 0));
}

export function maskOverlap(a, b) {
  let union = 0, both = 0;
  for (let i = 0; i < a.length; i++) { union += a[i] | b[i]; both += a[i] & b[i]; }
  return union ? both / union : 0;
}

/** Blurred, normalised brightness of the name text (robust to compression jitter). */
export function nameSignature(frame, roi, profile) {
  const [w, h] = profile.name.size;
  return normalise(gaussian3(toFloat(minChannel(resize(frame.crop(roi), w, h)))).data);
}

function comboPatch(frame, box, profile) {
  const [w, h] = profile.combo.patch_size;
  return normalise(resize(gray(frame.crop(box)), w, h).data);
}

/** The COMBO boxes for a given panel offset: [letter box, digit box at each search shift]. */
export function comboBoxes(profile, shift = [0, 0]) {
  const [sx, sy] = shift, C = profile.combo, [l1, t1, l2, t2] = C.letter_box, [d1, , d2] = C.digit_box;
  return [
    [l1 + sx, t1 + sy, l2 + sx, t2 + sy],
    C.digit_shifts.map((dx) => [d1 + sx + dx, t1 + sy, d2 + sx + dx, t2 + sy]),
  ];
}

/** About 0.6-0.75 when the round panel's COMBO count is 0, about 0.1-0.4 otherwise. */
export function comboZeroScore(frame, profile, shift = [0, 0]) {
  const [letterBox, digitBoxes] = comboBoxes(profile, shift);
  const letter = comboPatch(frame, letterBox, profile);
  return round(Math.max(...digitBoxes.map((box) => dot(letter, comboPatch(frame, box, profile)))), 3);
}

/** locate_counter: the layout that reads most often, and the followed player's name signature. */
export function locateCounter(frames, reader, profile, layouts = profile.counter.layouts) {
  const hits = layouts.map((layout) => frames.filter((f) => Object.keys(reader.read(f.crop(layout))).length));
  let best = 0;
  hits.forEach((h, i) => { if (h.length > hits[best].length) best = i; });
  if (hits[best].length < profile.counter.min_hits) {
    throw new Error('Cannot find a readable kill counter in this video; this HUD layout is not supported.');
  }
  const roi = [...layouts[best]], names = nameRoi(profile, roi), O = profile.name.mask_overlap;
  const masks = hits[best].map((f) => nameMask(f, names, profile));
  const support = masks.map((a) => masks.filter((b) => maskOverlap(a, b) > O).length);
  const medoid = masks[support.indexOf(Math.max(...support))];
  const same = hits[best].filter((_, i) => maskOverlap(medoid, masks[i]) > O);
  const reference = new Float32Array(profile.name.size[0] * profile.name.size[1]);
  for (const f of same) {
    const s = nameSignature(f, names, profile);
    for (let i = 0; i < s.length; i++) reference[i] += s[i] / same.length;
  }
  const norm = Math.sqrt(dot(reference, reference));
  return { roi, nameReference: reference.map((v) => v / norm), hits: hits.map((h) => h.length) };
}

/** locate_hp_bar: [layout, level] of the HP bar, or [null, null] when no layout reads as a full bar. */
export function locateHpBar(frames, profile) {
  const H = profile.hp;
  if (!frames.length) return [null, null];
  const best = (levels) => {
    const scores = H.layouts.map((layout, i) => percentile(frames.map((f) => hpFill(f.crop(layout), levels[i])), 75));
    const i = scores.indexOf(Math.max(...scores));
    return [i, scores[i]];
  };
  let [i, score] = best(H.layouts.map(() => H.level));
  if (score >= H.full_score) return [[...H.layouts[i]], H.level];
  const levels = H.layouts.map((layout) => Math.min(H.level,
    percentile(frames.map((f) => median(columnPeaks(f.crop(layout)))), 75) - H.dim_offset));
  [i, score] = best(levels);
  return score >= H.full_score && levels[i] >= H.min_dim_level ? [[...H.layouts[i]], round(levels[i], 1)] : [null, null];
}

/** locate_combo_shift: (x, y) offset of the round panel's COMBO word from its usual place. */
export function locateComboShift(frames, profile, comboBytes) {
  const C = profile.combo, [th, tw] = C.word_template.shape;
  const templ = { w: tw, h: th, c: 1, data: Float32Array.from(comboBytes) };
  const found = [];
  for (const f of frames) {
    const { w, h } = f;
    const [ax1, ay1] = [Math.trunc(C.search_box[0] * w), Math.trunc(C.search_box[1] * h)];
    let area = toFloat(minChannel(f.crop(C.search_box)));
    const scale = C.word_template.height / h;
    area = resize(area, 0, 0, 'area', scale, scale);
    if (area.h < th || area.w < tw) continue;
    const m = matchTemplateBest(area, templ);
    if (m.score >= C.min_match) {
      found.push([(ax1 + m.x / scale) / w - C.word_origin[0], (ay1 + m.y / scale) / h - C.word_origin[1]]);
    }
  }
  if (found.length < C.min_found) return [0, 0];
  const dx = median(found.map((p) => p[0])), dy = median(found.map((p) => p[1]));
  if (Math.abs(dx) < .0005 && Math.abs(dy) < .001) return [0, 0];
  return [round(dx, 4), round(dy, 4)];
}

/** Every region the calibration functions crop, so frames can be cropped once and then closed. */
export function calibrationRegions(profile) {
  return [
    ...profile.counter.layouts,
    ...profile.counter.layouts.map((l) => nameRoi(profile, l)),
    ...profile.hp.layouts,
    profile.combo.search_box,
  ];
}

/** The regions read on every scan sample for a calibrated HUD. */
export function scanRegions(profile, hud) {
  const regions = [hud.roi, nameRoi(profile, hud.roi)];
  if (hud.hpRoi) regions.push(hud.hpRoi);
  if (hud.combo) {
    const [letter, digits] = comboBoxes(profile, hud.comboShift);
    regions.push(letter, ...digits);
  }
  return regions;
}

/** One reading (scan_video's per-sample dict) from a frame. */
export function readHud(frame, t, hud, reader, profile) {
  const r = { time: round(t, 3) };
  if (hud.hpRoi) r.hp = hpFill(frame.crop(hud.hpRoi), hud.hpLevel);
  if (hud.nameReference) r.who = round(dot(hud.nameReference, nameSignature(frame, nameRoi(profile, hud.roi), profile)), 3);
  if (hud.combo) r.combo_zero = comboZeroScore(frame, profile, hud.comboShift);
  return Object.assign(r, reader.read(frame.crop(hud.roi)));
}
