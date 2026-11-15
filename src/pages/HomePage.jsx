
import { useRef } from 'react';
import {
  CommunityCardsMobile,
  GitHubCard,
  PatreonCard,
  PrivacyCard,
  ReachUsOutCard,
} from '../components/CommunityCards';
import HowItWorks from '../components/HowItWorks';
import ResultsPanel from '../components/ResultsPanel';
import ScanProgress from '../components/ScanProgress';
import UploadPanel from '../components/UploadPanel';
import { useClipFinder } from '../useClipFinder';

export default function HomePage() {
  const finder = useClipFinder();
  const inputRef = useRef(null);

  const handleReset = () => {
    finder.reset();

    if (inputRef.current) {
      inputRef.current.value = '';
    }
  };

  const isChoosing = finder.stage === 'choose';

  return (
    <main className="homepage-enter mx-auto grid w-full max-w-[1360px] grid-cols-1 items-start gap-5 px-3 pb-8 min-[400px]:px-4 sm:gap-7 sm:px-6 xl:grid-cols-[minmax(190px,220px)_minmax(0,680px)_minmax(190px,220px)] xl:justify-center xl:gap-8 xl:px-7">

      {/* Left sidebar */}
      <aside className="hidden space-y-5 xl:block xl:pt-2">
        <GitHubCard />
        <ReachUsOutCard />
      </aside>

      {/* Main workspace */}
      <div className="mx-auto w-full max-w-[680px] min-w-0">
        {finder.stage === 'choose' && (
          <UploadPanel finder={finder} inputRef={inputRef} />
        )}

        {finder.stage === 'scanning' && (
          <ScanProgress finder={finder} />
        )}

        {finder.stage === 'results' && (
          <ResultsPanel finder={finder} onReset={handleReset} />
        )}

        {isChoosing && (
          <>
            <HowItWorks />

            <div className="mt-6 xl:hidden">
              <CommunityCardsMobile />
            </div>
          </>
        )}
      </div>

      {/* Right sidebar */}
      <aside className="hidden space-y-5 xl:block xl:pt-2">
        <PatreonCard />
        <PrivacyCard />
      </aside>

    </main>
  );
}
