// Runs live.js's per-sample killfeed matching for worker.js on one run of the samples. Messages in: load, work.
import { sampleWork } from './live.js';

let data = null, offset = 0;

self.onmessage = ({ data: message }) => {
  if (message.type === 'load') {
    data = { shape: message.shape, samples: message.samples };
    offset = message.offset;
    return;
  }
  try {
    const out = message.indices.map((i) => sampleWork(data, i - offset, message.job));
    postMessage({ id: message.id, out });
  } catch (error) {
    postMessage({ id: message.id, error: error.message || String(error) });
  }
};
