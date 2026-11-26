
import { FileVideo, UploadCloud, X } from 'lucide-react';
import GlideSelect from './GlideSelect';

const recordingFormats = [
  { value: 'live', label: 'Live Match recording' },
  { value: 'replay', label: 'Replay Mode recording' },
];

const killOptions = [2, 3, 4, 5, 6, 7, 8].map((value) => ({
  value,
  label: `${value} kills`,
}));

const glideSelectStyles = {
  accentColor: '#f5f5f5',
  surfaceColor: '#27272a',
  highlightColor: '#3f3f46',
  textColor: '#f5f5f5',
  size: 'md',
  radius: 10,
  placement: 'bottom',
  align: 'left',
  popDuration: 180,
  glideDuration: 220,
  rememberPosition: true,
};

export default function UploadPanel({ finder, inputRef }) {
  const selectedFiles = finder.selectedFiles || [];

  const selectionLabel = selectedFiles.length > 1
    ? finder.text.picked(selectedFiles.length)
    : selectedFiles[0]?.name || 'Select Match Recording';

  const onFileChange = (event) => {
    finder.selectFiles(event.target.files);
  };

  const onDrop = (event) => {
    event.preventDefault();
    finder.setIsDragging(false);
    finder.selectFiles(event.dataTransfer.files);
  };

  return (
    <section
      className="rounded-xl border border-line bg-panel px-3.5 py-4 shadow-glow min-[400px]:px-4 min-[400px]:py-5 sm:px-5 sm:py-7"
      aria-label="Choose a match recording"
    >
      <div className="flex flex-col gap-2.5 sm:flex-row sm:gap-3">
        <div className="flex min-w-0 flex-1 items-stretch gap-2">
          <label
            htmlFor="recording"
            onDragEnter={(event) => {
              event.preventDefault();
              finder.setIsDragging(true);
            }}
            onDragOver={(event) => {
              event.preventDefault();
              finder.setIsDragging(true);
            }}
            onDragLeave={(event) => {
              event.preventDefault();
              finder.setIsDragging(false);
            }}
            onDrop={onDrop}
            className={`group relative flex min-h-[3.35rem] min-w-0 flex-1 cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg border px-3 text-sm transition-colors sm:h-[3.4rem] sm:rounded-md sm:px-4 ${
              finder.isDragging
                ? 'border-green bg-green/10'
                : selectedFiles.length
                  ? 'border-green text-white'
                  : 'border-[#778078] bg-surface text-muted hover:border-green hover:bg-[#202622]'
            }`}
          >
            <input
              ref={inputRef}
              id="recording"
              type="file"
              accept="video/mp4,video/quicktime,video/*"
              multiple
              onChange={onFileChange}
              className="sr-only"
            />

            {selectedFiles.length ? (
              <FileVideo size={19} className="shrink-0 text-green" />
            ) : (
              <UploadCloud size={19} className="shrink-0 text-green" />
            )}

            <span className="min-w-0 truncate">{selectionLabel}</span>

            <span className="pointer-events-none absolute inset-0 rounded-lg ring-green/40 group-focus-within:ring-2" />
          </label>

          {selectedFiles.length > 0 && (
            <button
              type="button"
              aria-label="Remove selected recording(s)"
              title="Remove selected recording(s)"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                finder.clearSelectedFiles();

                if (inputRef.current) {
                  inputRef.current.value = '';
                }
              }}
              disabled={finder.stage === 'scanning'}
              className="flex h-[3.35rem] w-11 shrink-0 items-center justify-center rounded-lg border border-[#59635c] bg-surface text-muted transition-colors hover:border-[#a85b55] hover:bg-[#2a1715] hover:text-[#ffaaa1] disabled:cursor-not-allowed disabled:opacity-40 sm:h-[3.4rem] sm:rounded-md"
            >
              <X size={18} strokeWidth={2.25} />
            </button>
          )}
        </div>

        <button
          type="button"
          onClick={finder.startScan}
          disabled={
            !selectedFiles.length ||
            !finder.supported ||
            finder.stage === 'scanning'
          }
          className="h-[3.35rem] w-full rounded-lg bg-green px-5 text-sm font-bold uppercase tracking-[0.08em] text-[#041209] transition-colors hover:bg-green-dark disabled:cursor-not-allowed disabled:opacity-40 sm:h-[3.4rem] sm:w-auto sm:min-w-[140px] sm:rounded-md sm:px-6"
        >
          Find clips
        </button>
      </div>

      {selectedFiles.length > 1 && (
        <p className="mt-2 text-center text-xs text-muted">
          {selectedFiles.length} recordings will be scanned one at a time.
        </p>
      )}

      <div className="mt-4 grid grid-cols-1 gap-3 sm:mt-5 sm:flex sm:flex-wrap sm:items-center sm:justify-center sm:gap-x-7">

        {/* Recording Type - GlideSelect */}
        <div className="flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-[#121713] px-3 text-sm font-semibold text-white sm:h-auto sm:w-auto sm:justify-normal sm:rounded-none sm:border-0 sm:bg-transparent sm:px-0">
          <span>Recording type</span>

          <GlideSelect
            options={recordingFormats}
            value={finder.format}
            onChange={(value) => finder.setFormat(value)}
            ariaLabel="Recording type"
            showTags
            accentColor={glideSelectStyles.accentColor}
            surfaceColor={glideSelectStyles.surfaceColor}
            highlightColor={glideSelectStyles.highlightColor}
            textColor={glideSelectStyles.textColor}
            size={glideSelectStyles.size}
            radius={glideSelectStyles.radius}
            menuWidth={176}
            placement={glideSelectStyles.placement}
            align={glideSelectStyles.align}
            popDuration={glideSelectStyles.popDuration}
            glideDuration={glideSelectStyles.glideDuration}
            rememberPosition={glideSelectStyles.rememberPosition}
            disabled={finder.stage === 'scanning'}
          />
        </div>

        {/* Minimum Kills - GlideSelect */}
        <div className="flex h-11 w-full items-center justify-between gap-3 rounded-lg border border-line bg-[#121713] px-3 text-sm font-semibold text-white sm:h-auto sm:w-auto sm:justify-normal sm:rounded-none sm:border-0 sm:bg-transparent sm:px-0">
          <span>Minimum kills</span>

          <GlideSelect
            options={killOptions}
            value={finder.minKills}
            onChange={(value) => finder.setMinKills(Number(value))}
            ariaLabel="Minimum kills"
            showTags={false}
            accentColor={glideSelectStyles.accentColor}
            surfaceColor={glideSelectStyles.surfaceColor}
            highlightColor={glideSelectStyles.highlightColor}
            textColor={glideSelectStyles.textColor}
            size={glideSelectStyles.size}
            radius={glideSelectStyles.radius}
            menuWidth={140}
            placement={glideSelectStyles.placement}
            align={glideSelectStyles.align}
            popDuration={glideSelectStyles.popDuration}
            glideDuration={glideSelectStyles.glideDuration}
            rememberPosition={glideSelectStyles.rememberPosition}
            disabled={finder.stage === 'scanning'}
          />
        </div>

      </div>

      {!finder.supported && (
        <p className="mt-4 rounded-md border border-[#70413c] bg-[#2a1715] px-3 py-2.5 text-sm leading-6 text-[#ffaaa1]">
          This browser can’t scan videos. Please use a recent Chrome or Edge over HTTPS.
        </p>
      )}

      {finder.resultMessage && finder.stage === 'choose' && (
        <p className="mt-4 rounded-md border border-[#70413c] bg-[#2a1715] px-3 py-2.5 text-sm leading-6 text-[#ffaaa1]">
          {finder.resultMessage}
        </p>
      )}

      <p className="mt-3 text-center text-[12px] leading-5 text-[#FFFFFF] sm:mt-4 sm:text-[11px]">
        MP4 and MOV recordings · Processed locally in your browser
      </p>
    </section>
  );
}
