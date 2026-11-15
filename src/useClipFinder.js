import { useCallback, useEffect, useRef, useState } from 'react';
import JSZip from 'jszip';
import {
  MAX_BATCH_DOWNLOAD_BYTES,
  MAX_TOTAL_CLIP_BYTES,
  MAX_VIDEO_FILE_BYTES,
  validateVideoFile,
  safeFileStem,
} from './security/resourceLimits.js';

const TEXT = {
  pick: 'Select Match Recording',
  picked: (count) => `${count} recordings selected`,
  queue: (index, total, name) => `Recording ${index} of ${total}: ${name}`,
  unsupported: 'This browser can’t scan videos. Please use a recent Chrome or Edge.',
  starting: 'Calibrating Video',
  scanning: (pct) => `Analyzing Video ${pct}%`,
  eta: (time) => `Estimated time: ${time}`,
  finishing: 'Finalizing Clips',
  cutting: (done, total) => `Saving clips, ${done} of ${total}`,
  found: (count) => (count === 1 ? '1 clip found. Best first.' : `${count} clips found. Ordered by score.`),
  none: (kills) => `No clips found: no life in this recording had ${kills} or more kills.`,
  clipTitle: (rank, kills) => `Clip ${rank}: ${kills} kills`,
  clipInfo: (seconds, start) => `${seconds} s long, starts at ${start} in your recording`,
  download: 'Download',
  zipping: 'Downloading',
  notReplay: 'This doesn’t look like a Replay recording. Choose “In-game recording” and try again.',
  notLive: 'This doesn’t look like an in-game recording. Choose “Replay” and try again.',
  noName: 'We couldn’t find your name in the killfeed. A clearer recording resolution or quality is required.',
  badCodec: 'This browser can’t read this video’s format. Try a different browser.',
  failed: 'This video couldn’t be read. Check that it’s an MP4 match recording and try again.',
  noTimes: 'None found',
  videoInfo: (clips, kills) => `${clips === 1 ? '1 clip' : `${clips} clips`}, ${kills === 1 ? '1 kill' : `${kills} kills`} found`,
  videoFailed: 'Couldn’t be scanned',
  scanned: (recordings, clips) => `${recordings} recordings scanned, ${clips === 1 ? '1 clip' : `${clips} clips`} found. Open a recording to see only its clips.`,
  overallInfo: (count, sort) => `${count === 1 ? '1 clip' : `${count} clips`}, ${SORTS[sort].label}`,
  overallClipInfo: (seconds, start, file) => `${seconds} s long, starts at ${start} in ${file}`,
};

const SORTS = {
  score: { label: 'best score first', order: (a, b) => (b.score || 0) - (a.score || 0) || b.kills - a.kills },
  kills: { label: 'most kills first', order: (a, b) => b.kills - a.kills || (b.score || 0) - (a.score || 0) },
  time: { label: 'shortest first', order: (a, b) => a.seconds - b.seconds || (b.score || 0) - (a.score || 0) },
};

const PHASES = {
  calibrating: [0, 0.05],
  scanning: [0.05, 0.9],
  'match end': [0.9, 0.92],
  'following the killfeed': [0.9, 0.92],
};
const CUTTING = [0.92, 1];
const mmss = (seconds) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
const within = ([start, end], fraction) => start + (end - start) * fraction;
const isMobile = () => navigator.userAgentData?.mobile ?? /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);

function browserSupportsScanning() {
  return Boolean(
    window.isSecureContext &&
    'VideoDecoder' in window &&
    'OffscreenCanvas' in window &&
    'Worker' in window,
  );
}

function errorMessage(message = '') {
  if (/kill counter/.test(message)) return TEXT.notReplay;
  if (/killfeed/.test(message)) return TEXT.notLive;
  if (/name never shows/.test(message)) return TEXT.noName;
  if (/decode the video codec/.test(message)) return TEXT.badCodec;
  if (/safety limit|invalid or incomplete video metadata|selected file is empty|valid video file|exceeds ClipFinder|candidate clip|unsupported number of clips/.test(message)) return message;
  return TEXT.failed;
}

function safeErrorText(error) {
  return error?.message || TEXT.failed;
}

export function useClipFinder() {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [format, setFormat] = useState('live');
  const [minKills, setMinKills] = useState(3);
  const [stage, setStage] = useState('choose');
  const [supported] = useState(browserSupportsScanning);
  const [isDragging, setIsDragging] = useState(false);
  const [progress, setProgress] = useState(0);
  const [status, setStatus] = useState(TEXT.starting);
  const [eta, setEta] = useState('');
  const [queueText, setQueueText] = useState('');
  const [resultMessage, setResultMessage] = useState('');
  const [analysis, setAnalysis] = useState(null);
  const [results, setResults] = useState([]);
  const [clips, setClips] = useState([]);
  const [isDownloading, setIsDownloading] = useState(false);

  const workerRef = useRef(null);
  const runRef = useRef(null);
  const batchRef = useRef(null);
  const scanNextRef = useRef(null);
  const creepRef = useRef(null);
  const progressRef = useRef(0);
  const wakeLockRef = useRef(null);
  const resultsRef = useRef([]);
  const clipsRef = useRef([]);
  const retainedClipBytesRef = useRef(0);
  const recordingIdRef = useRef(0);

  const releaseWakeLock = useCallback(async () => {
    try {
      await wakeLockRef.current?.release();
    } catch {
      // The browser may release the wake lock automatically when the page is hidden.
    }
    wakeLockRef.current = null;
  }, []);

  const requestWakeLock = useCallback(async () => {
    try {
      if (!wakeLockRef.current && navigator.wakeLock?.request) {
        wakeLockRef.current = await navigator.wakeLock.request('screen');
      }
    } catch {
      wakeLockRef.current = null;
    }
  }, []);

  const stopWorker = useCallback((endSession = true) => {
    window.clearInterval(creepRef.current);
    creepRef.current = null;
    workerRef.current?.terminate();
    workerRef.current = null;
    if (runRef.current) runRef.current.finished = true;
    if (endSession) {
      window.removeEventListener('beforeunload', warnOnLeave);
      void releaseWakeLock();
    }
  }, [releaseWakeLock]);

  const setScanProgress = useCallback((fraction, nextStatus, nextEta = '') => {
    const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
    progressRef.current = pct;
    setProgress(pct);
    setStatus(nextStatus);
    setEta(nextEta);
  }, []);

  const startCreep = useCallback(([start, end], nextStatus) => {
    window.clearInterval(creepRef.current);
    creepRef.current = window.setInterval(() => {
      const now = progressRef.current / 100;
      setScanProgress(now + (end - now) * 0.03, nextStatus, '');
    }, 500);
  }, [setScanProgress]);

  const appendResult = useCallback((result) => {
    const nextResults = [...resultsRef.current, result];
    resultsRef.current = nextResults;
    setResults(nextResults);

    const nextClips = [...clipsRef.current, ...result.clips];
    clipsRef.current = nextClips;
    setClips(nextClips);
  }, []);

  const finishQueue = useCallback(() => {
    batchRef.current = null;
    runRef.current = null;
    window.removeEventListener('beforeunload', warnOnLeave);
    void releaseWakeLock();
    setQueueText('');
    const totalClips = clipsRef.current.length;
    const totalRecordings = resultsRef.current.length;
    if (totalRecordings) {
      setResultMessage(TEXT.scanned(totalRecordings, totalClips));
      setStage('results');
    } else {
      setStage('choose');
    }
  }, [releaseWakeLock]);

  const failCurrent = useCallback((message, stack) => {
    const run = runRef.current;
    if (!run || run.failureHandled) return;
    run.failureHandled = true;
    console.error(message, stack || '');
    stopWorker(false);

    run.clips.forEach((clip) => URL.revokeObjectURL(clip.url));
    const result = {
      id: run.id,
      file: run.file.name,
      format: run.format,
      message: errorMessage(message),
      analysis: null,
      clips: [],
      failed: true,
    };
    appendResult(result);
    runRef.current = null;
    void scanNextRef.current?.();
  }, [appendResult, stopWorker]);

  const finishRecording = useCallback(() => {
    const run = runRef.current;
    if (!run || run.resultCommitted) return;
    run.resultCommitted = true;
    stopWorker(false);

    const sortedClips = [...run.clips].sort((a, b) => a.rank - b.rank);
    retainedClipBytesRef.current += run.outputBytes || 0;
    appendResult({
      id: run.id,
      file: run.file.name,
      format: run.format,
      message: sortedClips.length ? TEXT.found(sortedClips.length) : TEXT.none(run.minKills),
      analysis: run.analysis,
      clips: sortedClips,
      failed: false,
    });
    setAnalysis(run.analysis || null);
    runRef.current = null;
    void scanNextRef.current?.();
  }, [appendResult, stopWorker]);

  const handleWorkerMessage = useCallback((event) => {
    const data = event.data;
    const run = runRef.current;
    if (!run || run.finished) return;

    switch (data.type) {
      case 'log':
        console.debug(`[scan] ${data.text}`);
        break;
      case 'info':
        run.info = data.info;
        break;
      case 'phase': {
        run.phase = data.phase;
        const range = PHASES[data.phase] || PHASES['match end'];
        window.clearInterval(creepRef.current);
        if (data.phase !== 'scanning') {
          const nextStatus = range[0] >= 0.9 ? TEXT.finishing : TEXT.starting;
          setScanProgress(range[0], nextStatus, '');
          startCreep(range, nextStatus);
        }
        break;
      }
      case 'progress': {
        const fraction = Math.min(1, data.seconds / Math.max(data.duration, 0.001));
        const total = within(PHASES.scanning, fraction);
        const speed = data.seconds / Math.max(data.elapsed, 0.001);
        const remaining = (data.duration - data.seconds) / Math.max(speed, 0.001);
        const nextEta = data.elapsed > 3 ? TEXT.eta(mmss(remaining)) : '';
        setScanProgress(total, TEXT.scanning(Math.round(total * 100)), nextEta);
        break;
      }
      case 'done': {
        run.analysis = data.analysis;
        const ordered = data.analysis.ranking
          .map((id) => data.analysis.clips.find((clip) => clip.id === id))
          .filter(Boolean);
        run.ordered = ordered;
        if (!ordered.length) {
          finishRecording();
          break;
        }
        window.clearInterval(creepRef.current);
        setScanProgress(CUTTING[0], TEXT.cutting(0, ordered.length), '');
        workerRef.current?.postMessage({
          type: 'cut',
          clips: ordered.map(({ id, start, end }) => ({ id, start, end })),
        });
        break;
      }
      case 'clip': {
        const ordered = run.ordered || [];
        const rank = ordered.findIndex((clip) => clip.id === data.id) + 1;
        const sourceClip = ordered[rank - 1];
        if (!sourceClip) break;
        const clipBytes = data.bytes?.byteLength ?? data.bytes?.length ?? 0;
        const pendingBytes = run.outputBytes || 0;
        if (retainedClipBytesRef.current + pendingBytes + clipBytes > MAX_TOTAL_CLIP_BYTES) {
          failCurrent('The combined clips reached ClipFinder’s 1 GiB session safety limit. Download the existing clips and refresh the page before scanning more recordings.', '');
          break;
        }
        run.outputBytes = pendingBytes + clipBytes;
        const seconds = Math.round(data.end - data.start);
        const filename = `${String(rank).padStart(2, '0')} - ${sourceClip.kills} kills - ${seconds} secs (${safeFileStem(run.file.name)}).mp4`;
        const videoFile = new File([data.bytes], filename, { type: 'video/mp4' });
        run.clips.push({
          rank,
          kills: sourceClip.kills,
          score: sourceClip.score || 0,
          start: data.start,
          seconds,
          recording: run.file.name,
          file: videoFile,
          url: URL.createObjectURL(videoFile),
        });
        setScanProgress(within(CUTTING, run.clips.length / ordered.length),
          TEXT.cutting(run.clips.length, ordered.length), '');
        break;
      }
      case 'cut-done':
        finishRecording();
        break;
      case 'error':
        failCurrent(data.message, data.stack);
        break;
      default:
        break;
    }
  }, [failCurrent, finishRecording, setScanProgress, startCreep]);

  const scanNext = useCallback(async () => {
    const batch = batchRef.current;
    if (!batch) return;

    if (batch.nextIndex >= batch.files.length) {
      finishQueue();
      return;
    }

    const file = batch.files[batch.nextIndex];
    batch.nextIndex += 1;
    const run = {
      id: ++recordingIdRef.current,
      file,
      format: batch.format,
      minKills: batch.minKills,
      phase: null,
      started: performance.now(),
      finished: false,
      failureHandled: false,
      resultCommitted: false,
      ordered: [],
      analysis: null,
      clips: [],
    };
    runRef.current = run;
    const queueTotal = batch.completedBefore + batch.files.length;
    const queueIndex = batch.completedBefore + batch.nextIndex;
    setQueueText(queueTotal > 1 ? TEXT.queue(queueIndex, queueTotal, file.name) : '');
    setScanProgress(0, TEXT.starting, '');

    try {
      const response = await fetch(`${import.meta.env.BASE_URL}hud-profile.json`);
      if (!response.ok) throw new Error(`Cannot load HUD profile: ${response.status}`);
      const profile = await response.json();
      // A scan can be cancelled while the profile is loading. Do not start a worker afterwards.
      if (batchRef.current !== batch || runRef.current !== run) return;
      const rules = { ...profile.rules, min_kills: batch.minKills };
      // Keep the scan-part override for local debugging only. Never let a public URL
      // control production worker concurrency.
      const rawParts = import.meta.env.DEV
        ? new URLSearchParams(window.location.search).get('parts')
        : null;
      const requestedParts = rawParts === null ? null : Number(rawParts);
      const parts = Number.isSafeInteger(requestedParts) && requestedParts >= 1 && requestedParts <= 4
        ? requestedParts
        : null;
      const worker = new Worker(new URL('./engine/worker.js', import.meta.url), { type: 'module' });
      workerRef.current = worker;
      worker.onmessage = handleWorkerMessage;
      worker.onerror = (error) => failCurrent(error.message || TEXT.failed, error.error?.stack);
      worker.postMessage({ type: 'scan', file, interval: rules.interval, rules, capture: 'auto', format: batch.format, parts });
    } catch (error) {
      if (batchRef.current === batch && runRef.current === run) {
        failCurrent(safeErrorText(error), error?.stack);
      }
    }
  }, [failCurrent, finishQueue, handleWorkerMessage, setScanProgress]);

  scanNextRef.current = scanNext;

  const startScan = useCallback(async () => {
    if (!selectedFiles.length || !supported || stage === 'scanning') return;

    const batch = {
      files: [...selectedFiles],
      nextIndex: 0,
      format,
      minKills,
      completedBefore: resultsRef.current.length,
    };
    batchRef.current = batch;
    setSelectedFiles([]);
    setResultMessage('');
    setQueueText('');
    setStage('scanning');
    setScanProgress(0, TEXT.starting, '');
    window.addEventListener('beforeunload', warnOnLeave);
    await requestWakeLock();
    if (batchRef.current === batch) void scanNextRef.current?.();
  }, [format, minKills, requestWakeLock, selectedFiles, setScanProgress, stage, supported]);

  const cancelScan = useCallback(() => {
    const activeRun = runRef.current;
    batchRef.current = null;
    stopWorker();
    activeRun?.clips.forEach((clip) => URL.revokeObjectURL(clip.url));
    runRef.current = null;
    setQueueText('');
    setEta('');
    if (resultsRef.current.length) {
      setResultMessage(TEXT.scanned(resultsRef.current.length, clipsRef.current.length));
      setStage('results');
    } else {
      setResultMessage('The scan was cancelled. Select a recording to try again.');
      setStage('choose');
    }
  }, [stopWorker]);

  // The existing “Scan another” action returns to the picker but deliberately keeps
  // completed recordings and their clip URLs, so the next scan joins the same results.
  const reset = useCallback(() => {
    if (stage === 'scanning') return;
    batchRef.current = null;
    runRef.current = null;
    setSelectedFiles([]);
    setResultMessage('');
    setQueueText('');
    setProgress(0);
    progressRef.current = 0;
    setStatus(TEXT.starting);
    setEta('');
    setStage('choose');
  }, [stage]);

  const download = useCallback((targetFile) => {
    const url = URL.createObjectURL(targetFile);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = targetFile.name;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, []);

  const saveFiles = useCallback(async (files, archiveName = 'ClipFinder clips.zip') => {
    if (!files.length) return;
    const totalBytes = files.reduce((total, item) => total + item.size, 0);
    if (!Number.isFinite(totalBytes) || totalBytes > MAX_BATCH_DOWNLOAD_BYTES) {
      throw new Error('These clips are too large to combine or share safely as one batch (limit: 256 MiB). Please download them individually.');
    }
    if (isMobile() && navigator.canShare?.({ files })) {
      try {
        await navigator.share({ files });
        return;
      } catch (error) {
        if (error?.name === 'AbortError') return;
      }
    }
    if (files.length === 1) {
      download(files[0]);
      return;
    }
    const zip = new JSZip();
    const usedNames = new Set();
    files.forEach((item, index) => {
      let name = item.name;
      if (usedNames.has(name)) {
        const dot = name.lastIndexOf('.');
        const stem = dot > 0 ? name.slice(0, dot) : name;
        const extension = dot > 0 ? name.slice(dot) : '';
        name = `${stem} (${index + 1})${extension}`;
      }
      usedNames.add(name);
      zip.file(name, item, { compression: 'STORE' });
    });
    const blob = await zip.generateAsync({ type: 'blob', streamFiles: true });
    const archive = new File([blob], archiveName, { type: 'application/zip' });
    download(archive);
  }, [download]);

  const runDownload = useCallback(async (files, archiveName) => {
    if (!files.length) return;
    setIsDownloading(true);
    try {
      await saveFiles(files, archiveName);
    } catch (error) {
      console.error('Could not prepare downloads:', error);
      setResultMessage(error?.message || 'The clips were found, but the download could not be prepared. Please try again.');
    } finally {
      setIsDownloading(false);
    }
  }, [saveFiles]);

  const downloadAll = useCallback(() => {
    const allFiles = resultsRef.current.flatMap((result) => result.clips.map((clip) => clip.file));
    void runDownload(allFiles, 'ClipFinder clips.zip');
  }, [runDownload]);

  const downloadRecordingClips = useCallback((recording) => {
    const files = recording.clips.map((clip) => clip.file);
    void runDownload(files, `${safeFileStem(recording.file)} clips.zip`);
  }, [runDownload]);

  const selectFiles = useCallback((fileList) => {
    const nextFiles = Array.from(fileList || []);
    if (!nextFiles.length) return;
    try {
      for (const nextFile of nextFiles) {
        if (nextFile.type && !nextFile.type.startsWith('video/')) {
          throw new Error('Please choose video recordings (MP4, MOV, or another supported video format).');
        }
        validateVideoFile(nextFile);
      }
    } catch (error) {
      setResultMessage(error.message || `Please choose a video smaller than ${MAX_VIDEO_FILE_BYTES / (1024 ** 3)} GiB.`);
      setSelectedFiles([]);
      return;
    }
    setSelectedFiles(nextFiles);
    setResultMessage('');
  }, []);

  const selectFile = useCallback((nextFile) => {
    if (!nextFile) return;
    selectFiles([nextFile]);
  }, [selectFiles]);

  const clearSelectedFiles = useCallback(() => {
    if (stage === 'scanning') return;
    setSelectedFiles([]);
    setResultMessage('');
  }, [stage]);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible' && runRef.current && !runRef.current.finished) {
        void requestWakeLock();
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      batchRef.current = null;
      stopWorker();
      clipsRef.current.forEach((clip) => URL.revokeObjectURL(clip.url));
      runRef.current?.clips.forEach((clip) => URL.revokeObjectURL(clip.url));
    };
  }, [requestWakeLock, stopWorker]);

  const file = selectedFiles[0] || null;
  const killTimes = analysis?.events?.flatMap((event) => Array(event.count).fill(event.time)) ?? [];
  const deathTimes = analysis?.deaths ?? null;

  return {
    file,
    files: selectedFiles,
    selectedFiles,
    format,
    setFormat,
    minKills,
    setMinKills,
    stage,
    supported,
    isDragging,
    setIsDragging,
    progress,
    status,
    eta,
    queueText,
    resultMessage,
    analysis,
    results,
    clips,
    isDownloading,
    killTimes,
    deathTimes,
    selectFile,
    selectFiles,
    clearSelectedFiles,
    startScan,
    cancelScan,
    reset,
    download,
    downloadAll,
    downloadRecordingClips,
    mmss,
    text: TEXT,
  };
}

function warnOnLeave(event) {
  event.preventDefault();
  event.returnValue = '';
}
