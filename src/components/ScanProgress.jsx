import { Activity, X } from 'lucide-react';

export default function ScanProgress({ finder }) {
  return (
    <section className="rounded-xl border border-line bg-panel p-4 shadow-glow min-[400px]:p-5 sm:p-7" aria-label="Scan progress">
      <div className="mb-4 flex items-center gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green/10 text-green">
          <Activity size={20} className="animate-pulse" />
        </span>
        <div className="min-w-0">
          <h2 className="font-semibold text-white">Scanning your recording</h2>
          <p className="mt-0.5 text-xs leading-5 text-muted">Keep this page open while ClipFinder works.</p>
          {finder.queueText && <p className="mt-1 break-words text-xs font-medium text-green-text" aria-live="polite">{finder.queueText}</p>}
        </div>
      </div>
      <div
        className="h-2.5 overflow-hidden rounded-full bg-[#242a26]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={finder.progress}
        aria-label="Video scan progress"
      >
        <div className="h-full rounded-full bg-green transition-[width] duration-300 ease-out" style={{ width: `${finder.progress}%` }} />
      </div>
      <div className="mt-3 flex flex-col gap-1.5 text-sm min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between">
        <span aria-live="polite" className="font-medium text-white">{finder.status}</span>
        <span className="text-xs text-muted min-[420px]:text-sm">{finder.eta}</span>
      </div>
      <div className="mt-5 flex flex-col gap-3 border-t border-line pt-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-xs leading-5 text-muted">Closing the tab or switching away may interrupt the scan.</p>
        <button type="button" onClick={finder.cancelScan} className="inline-flex min-h-11 w-full shrink-0 items-center justify-center gap-2 rounded-md border border-[#59635c] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-surface sm:w-auto">
          <X size={15} /> Cancel
        </button>
      </div>
    </section>
  );
}
