/** Conservative client-side limits to protect the tab from malformed or oversized recordings. */
export const MAX_VIDEO_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
export const MAX_VIDEO_DURATION_SECONDS = 2 * 60 * 60; // 2 hours
export const MAX_VIDEO_WIDTH = 4096;
export const MAX_VIDEO_HEIGHT = 4096;
export const MAX_VIDEO_PIXEL_COUNT = 9_000_000; // roughly 4K UHD / DCI 4K

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

/**
 * Phones, and computers that report under 4 GB of RAM, get tighter limits.
 * navigator.deviceMemory exists in Chrome/Edge only (pages and workers) and is capped at 8.
 */
export function isLowMemoryDevice() {
  const nav = globalThis.navigator;
  const mobile = nav?.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(nav?.userAgent || '');
  const memory = Number(nav?.deviceMemory);
  return Boolean(mobile || (Number.isFinite(memory) && memory > 0 && memory < 4));
}

const LOW_MEMORY = isLowMemoryDevice();

// Clips normally go to on-disk storage (engine/clipStore.js). These limits cover clips
// that must stay in memory, e.g. in browsers without it, until the page closes.
export const MAX_SINGLE_CLIP_BYTES = 512 * MiB;
export const MAX_TOTAL_CLIP_BYTES = LOW_MEMORY ? 1 * GiB : 8 * GiB; // all clips kept this session
// "Download all" builds each ZIP in memory, so large batches are split into several ZIPs.
// JSZip cannot write ZIP64, which also keeps every part well under the 4 GiB ZIP limit.
export const ZIP_PART_BYTES = LOW_MEMORY ? 256 * MiB : 1 * GiB;
export const MAX_SCAN_WORKERS = 4;

export function validateVideoFile(file) {
  if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size)) {
    throw new Error('Please choose a valid video file.');
  }
  if (file.size <= 0) {
    throw new Error('The selected file is empty. Please choose another recording.');
  }
  if (file.size > MAX_VIDEO_FILE_BYTES) {
    throw new Error('This recording is larger than ClipFinder’s 4 GiB safety limit. Please choose a smaller file.');
  }
}

export function validateVideoMetadata({ width, height, duration }) {
  if (![width, height, duration].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error('The recording has invalid or incomplete video metadata.');
  }
  if (duration > MAX_VIDEO_DURATION_SECONDS) {
    throw new Error('This recording is longer than ClipFinder’s 2-hour safety limit.');
  }
  if (width > MAX_VIDEO_WIDTH || height > MAX_VIDEO_HEIGHT || width * height > MAX_VIDEO_PIXEL_COUNT) {
    throw new Error('This recording exceeds ClipFinder’s supported 4K resolution safety limit.');
  }
}

export function safeFileStem(filename) {
  const withoutExtension = String(filename || 'ClipFinder').replace(/\.[^.]+$/, '');
  const safe = withoutExtension
    .replace(/[\\/\u0000-\u001f\u007f<>:"|?*]/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/^\.+|\.+$/g, '')
    .trim()
    .slice(0, 100);
  return safe || 'ClipFinder';
}
