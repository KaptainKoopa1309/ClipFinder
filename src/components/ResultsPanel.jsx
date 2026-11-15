import { useMemo, useState } from 'react';
import { Download, RotateCcw, ShieldAlert, Video } from 'lucide-react';

const OVERALL_SORTS = {
  score: {
    label: 'Best score first',
    compare: (a, b) => (b.score || 0) - (a.score || 0) || b.kills - a.kills,
  },
  kills: {
    label: 'Most kills first',
    compare: (a, b) => b.kills - a.kills || (b.score || 0) - (a.score || 0),
  },
  time: {
    label: 'Shortest first',
    compare: (a, b) => a.seconds - b.seconds || (b.score || 0) - (a.score || 0),
  },
};

export default function ResultsPanel({ finder, onReset }) {
  const [sortBy, setSortBy] = useState('score');
  const recordings = finder.results || [];
  const allClips = useMemo(
    () => recordings.flatMap((recording) => recording.clips || []),
    [recordings],
  );
  const overallClips = useMemo(
    () => [...allClips].sort(OVERALL_SORTS[sortBy].compare),
    [allClips, sortBy],
  );

  const totalRecordings = recordings.length;

  return (
    <section className="rounded-xl border border-line bg-panel p-3.5 shadow-glow min-[400px]:p-4 sm:p-6" aria-label="Scan results">
      <div className="flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green/10 text-green">
          <Video size={20} />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-white">Scan results</h2>
          <p className="mt-1 text-sm leading-6 text-muted">
            {finder.resultMessage || `${totalRecordings} ${totalRecordings === 1 ? 'recording' : 'recordings'} scanned.`}
          </p>
        </div>
      </div>

      {totalRecordings > 1 && allClips.length > 0 && (
        <section className="mt-5 rounded-lg border border-line bg-[#0a0d0b] p-3 min-[400px]:p-4" aria-label="Best clips from all recordings">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h3 className="font-semibold text-white">Best clips from all recordings</h3>
              <p className="mt-1 text-xs text-muted">{finder.text.overallInfo(allClips.length, sortBy)}</p>
            </div>
            <label className="flex min-h-10 items-center justify-between gap-3 rounded-md border border-line bg-[#121713] px-3 text-xs font-semibold text-white sm:justify-normal">
              <span>Sort by</span>
              <select
                value={sortBy}
                onChange={(event) => setSortBy(event.target.value)}
                className="h-8 rounded border border-line bg-surface px-2 text-xs text-white outline-none focus:border-green"
              >
                <option value="score">Score</option>
                <option value="kills">Kills</option>
                <option value="time">Time</option>
              </select>
            </label>
          </div>
          <div className="mt-4 space-y-4">
            {overallClips.map((clip, index) => (
              <ClipCard
                key={`overall-${clip.recording}-${clip.rank}-${index}`}
                clip={clip}
                place={index + 1}
                finder={finder}
                overall
              />
            ))}
          </div>
        </section>
      )}

      <div className="mt-5 space-y-3">
        {recordings.map((recording, index) => (
          <RecordingResult key={recording.id ?? `${recording.file}-${index}`} recording={recording} finder={finder} open={totalRecordings === 1} />
        ))}
      </div>

      <div className="mt-5 flex flex-col gap-2.5 border-t border-line pt-4 min-[400px]:gap-3 min-[400px]:pt-5 sm:flex-row">
        {allClips.length > 1 && (
          <button
            type="button"
            onClick={finder.downloadAll}
            disabled={finder.isDownloading}
            className="inline-flex min-h-11 w-full flex-1 items-center justify-center gap-2 rounded-md bg-green px-4 py-2 text-sm font-bold text-[#041209] transition-colors hover:bg-green-dark disabled:cursor-wait disabled:opacity-50 sm:w-auto sm:px-5"
          >
            <Download size={16} /> {finder.isDownloading ? 'Preparing download…' : totalRecordings > 1 ? 'Download all clips' : 'Download all clips'}
          </button>
        )}
        <button
          type="button"
          onClick={onReset}
          className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-[#59635c] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-surface sm:w-auto sm:px-5"
        >
          <RotateCcw size={15} /> Scan another
        </button>
      </div>
    </section>
  );
}

function RecordingResult({ recording, finder, open }) {
  const analysis = recording.analysis;
  const killTimes = analysis?.events?.flatMap((event) => Array(event.count).fill(event.time)) ?? [];
  const deaths = analysis?.deaths ?? null;
  const recordingClips = recording.clips || [];

  return (
    <details open={open} className="overflow-hidden rounded-lg border border-line bg-[#090c0a]">
      <summary className="flex cursor-pointer list-none flex-col gap-1.5 p-3 marker:text-green hover:bg-[#111713] min-[400px]:p-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <span className="flex min-w-0 items-center gap-2.5">
          <Video size={16} className="shrink-0 text-green" />
          <span className="truncate text-sm font-semibold text-white">{recording.file}</span>
        </span>
        <span className="pl-[26px] text-xs text-muted sm:pl-0">
          {recording.failed
            ? finder.text.videoFailed
            : finder.text.videoInfo(recordingClips.length, analysis ? killTimes.length : 0)}
        </span>
      </summary>

      <div className="border-t border-line p-3 min-[400px]:p-3.5 sm:p-4">
        <p className="text-sm leading-6 text-muted">{recording.message}</p>

        {analysis && (
          <div className="mt-4 rounded-lg border border-line bg-[#0a0d0b] p-3 min-[400px]:p-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-md bg-[#141a16] p-3">
                <p className="text-2xl font-bold tabular-nums text-green-text">{killTimes.length}</p>
                <p className="mt-1 text-xs text-muted">Kills found</p>
              </div>
              {Array.isArray(deaths) && (
                <div className="rounded-md bg-[#141a16] p-3">
                  <p className="text-2xl font-bold tabular-nums text-white">{deaths.length}</p>
                  <p className="mt-1 text-xs text-muted">Deaths found</p>
                </div>
              )}
            </div>
            <p className="mt-3 text-xs leading-5 text-muted">Compare these with your match scoreboard. If they’re far off, some clips may be wrong.</p>
            <details className="mt-4 border-t border-line pt-3">
              <summary className="cursor-pointer text-sm font-medium text-[#dce4de] marker:text-green">Show when each kill and death happened</summary>
              <div className="mt-3 space-y-3">
                <TimeList label="Kills" values={killTimes} formatTime={finder.mmss} />
                {Array.isArray(deaths) && <TimeList label="Deaths" values={deaths} formatTime={finder.mmss} />}
              </div>
            </details>
          </div>
        )}

        {analysis?.warnings > 0 && (
          <div className="mt-4 flex items-start gap-2 rounded-md border border-[#725d36] bg-[#211b10] p-3 text-xs leading-5 text-[#e9cb8d]">
            <ShieldAlert size={16} className="mt-0.5 shrink-0" />
            {analysis.warnings} uncertain counter transition(s) were detected. Review the clips before using them.
          </div>
        )}

        {recordingClips.length > 0 ? (
          <div className="mt-4 space-y-4">
            {recordingClips.slice().sort((a, b) => a.rank - b.rank).map((clip) => (
              <ClipCard key={`${recording.id}-${clip.rank}`} clip={clip} finder={finder} />
            ))}
          </div>
        ) : null}

        {recordingClips.length > 1 && (
          <button
            type="button"
            onClick={() => finder.downloadRecordingClips(recording)}
            disabled={finder.isDownloading}
            className="mt-4 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-md border border-[#59635c] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-surface disabled:opacity-50 sm:w-auto"
          >
            <Download size={15} /> Download all clips from this recording
          </button>
        )}
      </div>
    </details>
  );
}

function ClipCard({ clip, place, finder, overall = false }) {
  const titleRank = place ?? clip.rank;
  const info = overall
    ? finder.text.overallClipInfo(clip.seconds, finder.mmss(clip.start), clip.recording)
    : finder.text.clipInfo(clip.seconds, finder.mmss(clip.start));

  return (
    <article className="overflow-hidden rounded-lg border border-line bg-[#090c0a]">
      <video
        className="aspect-video w-full bg-black object-contain"
        src={`${clip.url}#t=0.1`}
        controls
        playsInline
        preload="metadata"
      />
      <div className="flex flex-col gap-3 p-3 min-[400px]:p-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-4">
        <div className="min-w-0">
          <h3 className="font-semibold text-white">{finder.text.clipTitle(titleRank, clip.kills)}</h3>
          <p className="mt-1 text-xs text-muted">{info}</p>
        </div>
        <button
          type="button"
          onClick={() => finder.download(clip.file)}
          className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-green px-4 py-2 text-sm font-bold text-[#041209] transition-colors hover:bg-green-dark sm:h-10 sm:min-h-0 sm:w-auto sm:py-0"
        >
          <Download size={15} /> Download
        </button>
      </div>
    </article>
  );
}

function TimeList({ label, values, formatTime }) {
  return (
    <div>
      <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-muted">{label}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.length ? values.map((time, index) => (
          <span key={`${label}-${index}`} className="rounded bg-[#1a211c] px-2 py-1 font-mono text-xs text-[#dce7df]">{formatTime(time)}</span>
        )) : <span className="text-xs text-muted">None found</span>}
      </div>
    </div>
  );
}
