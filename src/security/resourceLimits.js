/** Conservative client-side limits to protect the tab from malformed or oversized recordings. */
export const MAX_VIDEO_FILE_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
export const MAX_VIDEO_DURATION_SECONDS = 2 * 60 * 60; // 2 hours
export const MAX_VIDEO_WIDTH = 4096;
export const MAX_VIDEO_HEIGHT = 4096;
export const MAX_VIDEO_PIXEL_COUNT = 9_000_000; // roughly 4K UHD / DCI 4K

// The scanner copies original encoded packets into memory-backed MP4 outputs.
export const MAX_SINGLE_CLIP_BYTES = 512 * 1024 * 1024; // 512 MiB
export const MAX_TOTAL_CLIP_BYTES = 1024 * 1024 * 1024; // 1 GiB per scan
export const MAX_BATCH_DOWNLOAD_BYTES = 256 * 1024 * 1024; // 256 MiB before ZIP creation
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
