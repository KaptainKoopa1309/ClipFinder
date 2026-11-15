export default function SiteHeader() {
  return (
    <header className="px-3 pb-4 pt-6 text-center min-[400px]:px-4 sm:pb-5 sm:pt-10">
      <a
        href="/"
        className="inline-flex items-center text-[2.15rem] font-bold leading-none tracking-tight text-white transition-opacity hover:opacity-90 min-[400px]:text-[2.35rem] sm:text-[2.65rem]"
        aria-label="ClipFinder home"
      >
        Clip<span className="text-green">Finder</span>
      </a>
    </header>
  );
}