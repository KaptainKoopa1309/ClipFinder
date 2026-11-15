
import { BrowserRouter, Route, Routes, useLocation } from 'react-router-dom';

import SiteFooter from './components/SiteFooter';
import SiteHeader from './components/SiteHeader';
import Aurora from './components/Aurora';

import HomePage from './pages/HomePage';
import ReachUsOutPage from './pages/ReachUsOutPage';
import { PrivacyPage, TermsPage } from './pages/InfoPages';

function AppLayout() {
  const location = useLocation();
  const showAurora = location.pathname === '/';

  return (
    <div className="relative isolate min-h-screen overflow-x-hidden bg-ink text-white">

      {/* Homepage-only Aurora */}
      {showAurora && (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-0 h-[480px]">
          <Aurora
            colorStops={[
              '#052E16',
              '#15803D',
              '#22C55E',
              '#14532D'
            ]}
            amplitude={0.55}
            blend={0.75}
            speed={0.25}
            height={0.42}
            scale={0.8}
            glow={0.65}
            brightness={0.65}
            layers={2}
            direction="top"
            mouseInteraction={false}
            intro={true}
            opacity={0.55}
            lightMode={false}
            dpr={1.5}
          />

          {/* Fade into black */}
          <div className="absolute inset-0 bg-gradient-to-b from-transparent via-transparent to-ink" />
        </div>
      )}

      {/* Website content */}
      <div className="relative z-10">
        <SiteHeader />

        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/contact" element={<ReachUsOutPage />} />
          <Route path="/suggestions" element={<ReachUsOutPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="*" element={<HomePage />} />
          <Route path="/reach-us-out" element={<ReachUsOutPage />} />
        </Routes>

        <SiteFooter />
      </div>

    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppLayout />
    </BrowserRouter>
  );
}
