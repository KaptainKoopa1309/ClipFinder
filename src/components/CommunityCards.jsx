
import {
  ArrowUpRight,
  Github,
  Instagram,
  Lightbulb,
} from 'lucide-react';
import { Link } from 'react-router-dom';

const GITHUB_URL = 'https://github.com/KaptainKoopa1309/ClipFinder';
const PATREON_URL = '';

// Developer social links
const DEVELOPERS = [
  {
    name: 'Zorawar Singh Bajwa',
    instagram: 'https://www.instagram.com/luigicodm_13/',
    twitter: 'https://x.com/Weegiethfc',
  },
  {
    name: 'Harshit Verma',
    instagram: 'https://www.instagram.com/revil.fps1/',
    twitter: 'https://x.com/Revilftw',
  },
];

// X / Twitter icon
function XIcon({ size = 15, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <path d="M18.9 2H22l-6.8 7.8L23.2 22h-6.3l-4.9-7.7L5.3 22H2.1l7.3-8.4L1.5 2h6.5l4.4 7.1L18.9 2zm-1.1 18h1.7L7 3.9H5.2L17.8 20z" />
    </svg>
  );
}

// Patreon mark
function PatreonMark({ size = 20, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="2" width="5.5" height="20" rx="2" />
      <circle cx="16" cy="8" r="6" />
    </svg>
  );
}

// Custom developer code icon
// Each SVG path animates independently.
function DeveloperCodeIcon({ size = 20 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="developer-code-icon"
      aria-hidden="true"
    >
      <path
        className="code-bracket-left"
        d="m8 8-4 4 4 4"
      />

      <path
        className="code-bracket-right"
        d="m16 8 4 4-4 4"
      />

      <path
        className="code-slash"
        d="m14 4-4 16"
      />
    </svg>
  );
}

// Reusable card wrapper
function CardShell({ children, className = '' }) {
  return (
    <section
      className={`rounded-xl border border-line bg-panel p-5 shadow-[0_8px_30px_rgba(0,0,0,0.18)] ${className}`}
    >
      {children}
    </section>
  );
}

// Reusable social link
function SocialIconLink({ href, label, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      title={label}
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[#31563b] bg-green/5 text-[#9ca99f] transition-colors duration-150 hover:border-green/50 hover:bg-green/10 hover:text-green focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green"
    >
      {children}
    </a>
  );
}

// Contact bulb
function BulbIcon({ size = 20 }) {
  return (
    <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[#31563b] bg-green/10 text-green">
      <Lightbulb
        size={size}
        className="community-hover-icon"
      />
    </div>
  );
}

// Individual developer profile
function DeveloperRow({ developer }) {
  return (
    <div className="min-w-0">
      <p className="text-sm font-semibold leading-5 text-white">
        {developer.name}
      </p>

      <div className="mt-2 flex items-center gap-2">
        <SocialIconLink
          href={developer.instagram}
          label={`${developer.name} on Instagram`}
        >
          <Instagram
            size={15}
            className="community-hover-icon"
          />
        </SocialIconLink>

        <SocialIconLink
          href={developer.twitter}
          label={`${developer.name} on X`}
        >
          <XIcon
            size={14}
            className="community-hover-icon"
          />
        </SocialIconLink>
      </div>
    </div>
  );
}

// Developer credits
export function DevelopersCard() {
  return (
    <CardShell className="relative overflow-hidden border-[#294331] bg-[linear-gradient(145deg,#101a13,#0e1113_75%)]">

      <div className="pointer-events-none absolute -right-10 -top-10 h-32 w-32 rounded-full bg-green/5 blur-3xl" />

      <div className="relative">

        {/* Custom animated code icon */}
        <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[#31563b] bg-green/10 text-green">
          <DeveloperCodeIcon size={20} />
        </div>

        {/* Static heading */}
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-green-text">
          The developers
        </p>

        <div className="mt-4 space-y-4">
          <DeveloperRow developer={DEVELOPERS[0]} />

          <div className="h-px w-full bg-gradient-to-r from-[#31563b] to-transparent" />

          <DeveloperRow developer={DEVELOPERS[1]} />
        </div>

      </div>
    </CardShell>
  );
}

// Backward compatibility with existing HomePage imports
export { DevelopersCard as PrivacyCard };

// GitHub card
export function GitHubCard() {
  return (
    <CardShell>
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[#343b36] bg-[#171d19] text-white">
        <Github
          size={20}
          className="github-cat-hover"
        />
      </div>

      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-green-text">
        Open source
      </p>

      <p className="mt-2 text-sm leading-6 text-muted">
        Explore ClipFinder's source code, see how it works, or contribute an improvement.
      </p>

      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="mt-5 inline-flex items-center gap-2 text-sm font-semibold text-green-text transition-colors hover:text-green"
      >
        View on GitHub

        <ArrowUpRight
          size={15}
          className="community-hover-icon"
        />
      </a>
    </CardShell>
  );
}

// Reach out card
export function ReachUsOutCard() {
  return (
    <CardShell className="border-[#294331] bg-[linear-gradient(145deg,#101a13,#0e1113_70%)]">
      <div className="mb-4">
        <BulbIcon />
      </div>

      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-green-text">
        Get in touch
      </p>

      <p className="mt-2 text-sm leading-6 text-muted">
        Questions, feedback, bug reports, or ideas? Reach out to us.
      </p>

      <Link
        to="/reach-us-out"
        className="mt-5 inline-flex items-center gap-2 rounded-md bg-green px-3.5 py-2.5 text-sm font-bold text-[#041209] transition-colors hover:bg-green-dark"
      >
        Reach Out to Us

        <ArrowUpRight
          size={15}
          className="community-hover-icon"
        />
      </Link>
    </CardShell>
  );
}

// Patreon card
export function PatreonCard() {
  return (
    <CardShell className="border-[#3b2a36] bg-[linear-gradient(145deg,#1b1219,#0e1113_70%)]">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg border border-[#593549] bg-[#f472b6]/10 text-[#f472b6]">
        <PatreonMark
          size={20}
          className="patreon-p-hover"
        />
      </div>

      <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[#f4a4cb]">
        Support development
      </p>

      <p className="mt-2 text-sm leading-6 text-muted">
        ClipFinder is free to use. Support helps fund improvements, testing, and maintenance.
      </p>

      {PATREON_URL ? (
        <a
          href={PATREON_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-5 inline-flex items-center gap-2 rounded-md bg-[#f472b6] px-3.5 py-2.5 text-sm font-bold text-[#210c18] transition-colors hover:bg-[#f9a8d4]"
        >
          Support on Patreon

          <ArrowUpRight
            size={15}
            className="community-hover-icon"
          />
        </a>
      ) : (
        <span
          className="mt-5 inline-flex cursor-not-allowed items-center gap-2 rounded-md border border-[#59404f] px-3.5 py-2.5 text-sm font-semibold text-[#d5a8c0]"
          title="Add the creator's Patreon URL in CommunityCards.jsx to enable this link."
        >
          Patreon link coming soon
        </span>
      )}
    </CardShell>
  );
}

// Mobile community layout
export function CommunityCardsMobile() {
  return (
    <div
      className="grid grid-cols-2 gap-3 md:grid-cols-4"
      aria-label="ClipFinder community links"
    >

      {/* GitHub */}
      <a
        href={GITHUB_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group flex min-w-0 flex-col rounded-xl border border-line bg-panel p-3 transition-colors hover:border-[#46534a] min-[420px]:p-3.5"
      >
        <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg border border-[#343b36] bg-[#171d19] text-white">
          <Github
            size={17}
            className="github-cat-hover"
          />
        </span>

        <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-green-text min-[420px]:text-[10px]">
          Open source
        </span>

        <span className="mt-1 text-sm font-semibold leading-5 text-white">
          GitHub
        </span>

        <span className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-green-text">
          View project

          <ArrowUpRight
            size={12}
            className="community-hover-icon"
          />
        </span>
      </a>

      {/* Patreon */}
      <div className="flex min-w-0 flex-col rounded-xl border border-[#3b2a36] bg-[linear-gradient(145deg,#1b1219,#0e1113_70%)] p-3 min-[420px]:p-3.5">
        <span className="mb-3 flex h-8 w-8 items-center justify-center rounded-lg border border-[#593549] bg-[#f472b6]/10 text-[#f472b6]">
          <PatreonMark
            size={17}
            className="patreon-p-hover"
          />
        </span>

        <span className="text-[9px] font-semibold uppercase tracking-[0.13em] text-[#f4a4cb] min-[420px]:text-[10px]">
          Support dev
        </span>

        <span className="mt-1 text-sm font-semibold leading-5 text-white">
          Patreon
        </span>

        {PATREON_URL ? (
          <a
            href={PATREON_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-1.5 flex items-center gap-1 text-[11px] font-medium text-[#f4a4cb]"
          >
            Support us

            <ArrowUpRight
              size={12}
              className="community-hover-icon"
            />
          </a>
        ) : (
          <span className="mt-1.5 text-[11px] text-[#c49caf]">
            Coming soon
          </span>
        )}
      </div>

      {/* Reach out */}
      <section className="col-span-2 flex min-w-0 flex-col gap-3 rounded-xl border border-[#294331] bg-[linear-gradient(145deg,#101a13,#0e1113_70%)] p-3 min-[420px]:flex-row min-[420px]:items-center min-[420px]:justify-between min-[420px]:p-3.5 md:col-span-2">
        <div className="flex min-w-0 items-start gap-3">
          <BulbIcon size={17} />

          <div className="min-w-0">
            <p className="text-[9px] font-semibold uppercase tracking-[0.13em] text-green-text min-[420px]:text-[10px]">
              Get in touch
            </p>

            <h2 className="mt-1 text-sm font-semibold text-white">
              Need to get in touch?
            </h2>

            <p className="mt-1 text-[11px] leading-4 text-muted">
              Send us feedback or report a problem.
            </p>
          </div>
        </div>

        <Link
          to="/reach-us-out"
          className="inline-flex min-h-10 w-full shrink-0 items-center justify-center gap-2 rounded-md bg-green px-3 py-2 text-xs font-bold text-[#041209] transition-colors hover:bg-green-dark min-[420px]:w-auto"
        >
          Reach Out to Us

          <ArrowUpRight
            size={14}
            className="community-hover-icon"
          />
        </Link>
      </section>

      {/* Developer credits */}
      <section className="relative col-span-2 overflow-hidden rounded-xl border border-[#294331] bg-[linear-gradient(145deg,#101a13,#0e1113_75%)] p-4">
        <div className="pointer-events-none absolute -right-8 -top-8 h-28 w-28 rounded-full bg-green/5 blur-3xl" />

        <div className="relative">
          <div className="mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-[#31563b] bg-green/10 text-green">
            <DeveloperCodeIcon size={18} />
          </div>

          <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-green-text">
            The developers
          </p>

          <div className="mt-4 space-y-4">
            <DeveloperRow developer={DEVELOPERS[0]} />

            <div className="h-px w-full bg-gradient-to-r from-[#31563b] to-transparent" />

            <DeveloperRow developer={DEVELOPERS[1]} />
          </div>
        </div>
      </section>

    </div>
  );
}
