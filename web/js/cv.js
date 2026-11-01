// The few OpenCV operations the HUD reader uses, written to give the same numbers as cv2.
// An image is {w, h, c, data}: interleaved rows, Uint8Array (8-bit) or Float32Array.

export function image(w, h, c = 1, Type = Float32Array) {
  return { w, h, c, data: new Type(w * h * c) };
}

/** video_analysis.crop's pixel rectangle: int(size*fraction) on each edge. */
export function cropRect(W, H, roi) {
  const [x1, y1, x2, y2] = roi;
  return [Math.trunc(W * x1), Math.trunc(H * y1), Math.trunc(W * x2), Math.trunc(H * y2)];
}

const f32 = Math.fround;

/** Per-axis taps for INTER_LINEAR (and INTER_AREA when enlarging), as in cv::resize. */
function linearTaps(ssize, dsize, scale, area) {
  const inv = 1 / scale;
  const index = new Int32Array(dsize), alpha = new Float32Array(dsize);
  for (let d = 0; d < dsize; d++) {
    let s, f;
    if (!area) {
      f = f32((d + 0.5) * scale - 0.5);
      s = Math.floor(f);
      f = f32(f - s);
    } else {
      s = Math.floor(d * scale);
      f = f32((d + 1) - (s + 1) * inv);
      f = f <= 0 ? 0 : f32(f - Math.floor(f));
    }
    if (s < 0) { f = 0; s = 0; }
    if (s >= ssize - 1) { f = 0; s = ssize - 1; }
    index[d] = s;
    alpha[d] = f;
  }
  return { index, alpha };
}

/** INTER_AREA taps when shrinking (computeResizeAreaTab): [source, weight] pairs per output. */
function areaTaps(ssize, dsize, scale) {
  const taps = [];
  for (let d = 0; d < dsize; d++) {
    const fs1 = d * scale, fs2 = fs1 + scale;
    const cell = Math.min(scale, ssize - fs1);
    let s2 = Math.min(Math.floor(fs2), ssize - 1);
    const s1 = Math.min(Math.ceil(fs1), s2);
    const list = [];
    if (s1 - fs1 > 1e-3) list.push([s1 - 1, f32((s1 - fs1) / cell)]);
    for (let s = s1; s < s2; s++) list.push([s, f32(1 / cell)]);
    if (fs2 - s2 > 1e-3) list.push([s2, f32(Math.min(Math.min(fs2 - s2, 1), cell) / cell)]);
    taps.push(list);
  }
  return taps;
}

/** cv2.resize; pass fx/fy to scale like cv2's fx=/fy=. 8-bit INTER_LINEAR matches OpenCV to the unit. */
export function resize(src, dw, dh, mode = 'linear', fx = 0, fy = 0) {
  let invX = dw / src.w, invY = dh / src.h;
  if (fx) {
    invX = fx; invY = fy;
    dw = Math.round(src.w * fx); dh = Math.round(src.h * fy);
  }
  const { c } = src;
  const eightBit = src.data instanceof Uint8Array || src.data instanceof Uint8ClampedArray;
  const out = image(dw, dh, c, eightBit ? Uint8Array : Float32Array);
  if (dw === src.w && dh === src.h) { out.data.set(src.data); return out; }
  const scaleX = 1 / invX, scaleY = 1 / invY;
  if (mode === 'area' && scaleX >= 1 && scaleY >= 1) {
    const tx = areaTaps(src.w, dw, scaleX), ty = areaTaps(src.h, dh, scaleY);
    const S = src.data, D = out.data;
    for (let y = 0; y < dh; y++) for (let x = 0; x < dw; x++) for (let k = 0; k < c; k++) {
      let sum = 0;
      for (const [sy, wy] of ty[y]) {
        let row = 0;
        for (const [sx, wx] of tx[x]) row += S[(sy * src.w + sx) * c + k] * wx;
        sum += row * wy;
      }
      D[(y * dw + x) * c + k] = eightBit ? Math.round(sum) : sum;
    }
    return out;
  }
  const area = mode === 'area';
  const X = linearTaps(src.w, dw, scaleX, area), Y = linearTaps(src.h, dh, scaleY, area);
  const S = src.data, D = out.data, W = src.w;
  if (eightBit) {
    // OpenCV's fixed-point CV_8U path: coefficients x2048, then (v + 2^21) >> 22.
    const ax = new Int32Array(dw * 2), ay = new Int32Array(dh * 2);
    for (let i = 0; i < dw; i++) { ax[2 * i] = roundEven((1 - X.alpha[i]) * 2048); ax[2 * i + 1] = roundEven(X.alpha[i] * 2048); }
    for (let i = 0; i < dh; i++) { ay[2 * i] = roundEven((1 - Y.alpha[i]) * 2048); ay[2 * i + 1] = roundEven(Y.alpha[i] * 2048); }
    const rows = new Map();
    const hrow = (sy) => {
      let r = rows.get(sy);
      if (r) return r;
      r = new Int32Array(dw * c);
      for (let x = 0; x < dw; x++) {
        const s0 = X.index[x], s1 = Math.min(s0 + 1, W - 1);
        for (let k = 0; k < c; k++) {
          r[x * c + k] = S[(sy * W + s0) * c + k] * ax[2 * x] + S[(sy * W + s1) * c + k] * ax[2 * x + 1];
        }
      }
      rows.set(sy, r);
      return r;
    };
    for (let y = 0; y < dh; y++) {
      const s0 = Y.index[y], s1 = Math.min(s0 + 1, src.h - 1);
      const r0 = hrow(s0), r1 = hrow(s1), b0 = ay[2 * y], b1 = ay[2 * y + 1];
      for (let i = 0; i < dw * c; i++) {
        const v = (r0[i] * b0 + r1[i] * b1 + (1 << 21)) >> 22;
        D[y * dw * c + i] = v < 0 ? 0 : v > 255 ? 255 : v;
      }
    }
    return out;
  }
  for (let y = 0; y < dh; y++) {
    const s0 = Y.index[y], s1 = Math.min(s0 + 1, src.h - 1), b = Y.alpha[y];
    for (let x = 0; x < dw; x++) {
      const t0 = X.index[x], t1 = Math.min(t0 + 1, W - 1), a = X.alpha[x];
      for (let k = 0; k < c; k++) {
        const top = S[(s0 * W + t0) * c + k] * (1 - a) + S[(s0 * W + t1) * c + k] * a;
        const bottom = S[(s1 * W + t0) * c + k] * (1 - a) + S[(s1 * W + t1) * c + k] * a;
        D[(y * dw + x) * c + k] = f32(top * (1 - b) + bottom * b);
      }
    }
  }
  return out;
}

function roundEven(v) {
  const r = Math.round(v);
  return Math.abs(v % 1) === 0.5 && r % 2 ? r - 1 : r;
}

/** frame.min(axis=2): the darkest channel of each pixel (same element type). */
export function minChannel(src) {
  const out = image(src.w, src.h, 1, src.data.constructor);
  const S = src.data, D = out.data, c = src.c;
  for (let i = 0, j = 0; i < D.length; i++, j += c) {
    let m = S[j];
    for (let k = 1; k < c; k++) if (S[j + k] < m) m = S[j + k];
    D[i] = m;
  }
  return out;
}

/** cv2.cvtColor(BGR2GRAY) on 8-bit data stored as RGB: OpenCV's 14-bit fixed-point weights. */
export function gray(src) {
  const out = image(src.w, src.h, 1, Uint8Array);
  const S = src.data, D = out.data, c = src.c;
  for (let i = 0, j = 0; i < D.length; i++, j += c) {
    D[i] = (S[j] * 4899 + S[j + 1] * 9617 + S[j + 2] * 1868 + 8192) >> 14;
  }
  return out;
}

export function toFloat(src) {
  return { w: src.w, h: src.h, c: src.c, data: Float32Array.from(src.data) };
}

/** cv2.GaussianBlur(img, (3, 3), 0) on one float channel: kernel [1/4, 1/2, 1/4], BORDER_REFLECT_101. */
export function gaussian3(src) {
  const { w, h } = src, S = src.data;
  const tmp = new Float32Array(w * h), out = image(w, h, 1);
  const at = (i, n) => (i < 0 ? -i : i >= n ? 2 * n - 2 - i : i);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    tmp[y * w + x] = .25 * S[y * w + at(x - 1, w)] + .5 * S[y * w + x] + .25 * S[y * w + at(x + 1, w)];
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    out.data[y * w + x] = .25 * tmp[at(y - 1, h) * w + x] + .5 * tmp[y * w + x] + .25 * tmp[at(y + 1, h) * w + x];
  }
  return out;
}

/** g - mean, divided by its norm (left as is when flat). Returns a Float32Array. */
export function normalise(data) {
  let mean = 0;
  for (const v of data) mean += v;
  mean /= data.length;
  const out = new Float32Array(data.length);
  let norm = 0;
  for (let i = 0; i < data.length; i++) { out[i] = data[i] - mean; norm += out[i] * out[i]; }
  norm = Math.sqrt(norm);
  if (norm) for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

export function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

/** cv2.matchTemplate(area, templ, TM_CCOEFF_NORMED) followed by minMaxLoc's maximum: {score, x, y}. */
export function matchTemplateBest(area, templ) {
  const { w: W, h: H } = area, { w, h } = templ, A = area.data, n = w * h;
  let tmean = 0;
  for (const v of templ.data) tmean += v;
  tmean /= n;
  const T = new Float64Array(n);
  let tnorm = 0;
  for (let i = 0; i < n; i++) { T[i] = templ.data[i] - tmean; tnorm += T[i] * T[i]; }
  tnorm = Math.sqrt(tnorm);
  // Integral images of the area and its square give each window's mean and variance.
  const sum = new Float64Array((W + 1) * (H + 1)), sq = new Float64Array((W + 1) * (H + 1));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const v = A[y * W + x], i = (y + 1) * (W + 1) + x + 1;
    sum[i] = v + sum[i - 1] + sum[i - W - 1] - sum[i - W - 2];
    sq[i] = v * v + sq[i - 1] + sq[i - W - 1] - sq[i - W - 2];
  }
  const box = (I, x, y) => I[(y + h) * (W + 1) + x + w] - I[y * (W + 1) + x + w] - I[(y + h) * (W + 1) + x] + I[y * (W + 1) + x];
  let best = { score: -Infinity, x: 0, y: 0 };
  for (let y = 0; y + h <= H; y++) for (let x = 0; x + w <= W; x++) {
    let num = 0;
    for (let ty = 0; ty < h; ty++) {
      const row = (y + ty) * W + x, trow = ty * w;
      for (let tx = 0; tx < w; tx++) num += A[row + tx] * T[trow + tx];
    }
    const s = box(sum, x, y);
    const variance = Math.max(box(sq, x, y) - s * s / n, 0);
    const t = Math.sqrt(variance) * tnorm;
    // OpenCV's handling of near-flat windows (common_matchTemplate).
    let score;
    if (Math.abs(num) < t) score = num / t;
    else if (Math.abs(num) < t * 1.125) score = num > 0 ? 1 : -1;
    else score = 0;
    if (score > best.score) best = { score, x, y };
  }
  return best;
}

/** numpy.percentile with linear interpolation (the default). */
export function percentile(values, q) {
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q / 100, lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export const median = (values) => percentile(values, 50);

/** numpy.linspace(a, b, n). */
export function linspace(a, b, n) {
  if (n === 1) return [a];
  const step = (b - a) / (n - 1);
  return Array.from({ length: n }, (_, i) => (i === n - 1 ? b : a + i * step));
}

/** Python's round(x, digits) for display-precision values. */
export const round = (x, digits = 3) => Math.round(x * 10 ** digits) / 10 ** digits;
