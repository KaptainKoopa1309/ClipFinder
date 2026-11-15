import { Link } from 'react-router-dom';

export default function SiteFooter() {
  return (
    <footer className="mt-10 border-t border-line px-3 pb-6 pt-6 text-center min-[400px]:px-4 sm:mt-14 sm:px-4 sm:py-7">
      <nav className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs font-medium sm:gap-x-6 sm:text-sm">
        <Link className="text-muted transition-colors hover:text-green-text" to="/privacy">Privacy Policy</Link>
        <Link className="text-muted transition-colors hover:text-green-text" to="/terms">Terms of Use</Link>
      </nav>
      <p className="mx-auto mt-4 max-w-2xl text-[10px] leading-5 text-[#7d8981] sm:mt-5 sm:text-xs sm:leading-6">
        Not affiliated with Activision. Call of Duty is a trademark of Activision Publishing, Inc.
      </p>
    </footer>
  );
}
