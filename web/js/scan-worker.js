// Reads one part of a live recording for worker.js. Messages in: locate, scan, stop.
import { openTrack, scanLive, locateFrames } from './video.js';
import { loadLiveProfile } from './live.js';

let stopRequested = false, profile = null;

self.onmessage = async ({ data }) => {
  if (data.type === 'stop') { stopRequested = true; return; }
  try {
    const v = await openTrack(data.file, data.software);
    if (data.type === 'locate') {
      profile ??= await loadLiveProfile(new URL('../', import.meta.url));
      const result = await locateFrames(v, data.times, data.canvas, data.mode, profile);
      postMessage({ type: 'done', result }, result.count ? [result.count.buffer] : []);
    } else if (data.type === 'scan') {
      profile ??= await loadLiveProfile(new URL('../', import.meta.url));
      const { scan, data: part } = await scanLive(v, data.feed, profile, {
        start: data.start, end: data.end, mode: data.mode, shouldStop: () => stopRequested,
        onProgress: (p) => postMessage({ type: 'progress', done: p.done, decoded: p.decoded }),
      });
      const transfer = part.samples.flatMap((s) => [s.gold.buffer, s.light.buffer, s.sig.buffer]);
      postMessage({
        type: 'done',
        result: {
          readings: scan.readings, samples: part.samples, shape: part.shape, decoded: scan.decoded,
          duration: scan.duration, capture: scan.capture, stopped: scan.stopped,
        },
      }, transfer);
    }
  } catch (error) {
    postMessage({ type: 'error', message: error.message || String(error) });
  }
};
