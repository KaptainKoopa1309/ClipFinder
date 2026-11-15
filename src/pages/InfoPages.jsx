
import { Link } from 'react-router-dom';
import { ArrowLeft, ExternalLink } from 'lucide-react';

function InfoLayout({ title, children }) {
  return (
    <main className="legal-page-enter mx-auto w-full max-w-3xl px-4 pb-10 sm:px-6">
      <Link
        to="/"
        className="mb-5 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-muted transition-colors hover:text-green-text"
      >
        <ArrowLeft size={15} />
        Back to ClipFinder
      </Link>

      <article className="rounded-xl border border-line bg-panel p-4 min-[400px]:p-5 sm:p-8">
        <h1 className="text-xl font-bold text-white min-[400px]:text-2xl">
          {title}
        </h1>

        <div className="prose-clip mt-5 space-y-4 text-[13px] leading-6 min-[400px]:mt-6 min-[400px]:space-y-5 sm:text-sm sm:leading-7 text-[#b2bcb5]">
          {children}
        </div>
      </article>
    </main>
  );
}

export function PrivacyPage() {
  return (
    <InfoLayout title="Privacy Policy">
      <p>
        <strong className="font-semibold text-white">
          By using the ClipFinder website, you consent to our privacy policy.
          This page describes how your website usage related data is treated.
        </strong>
      </p>

      <h2>Data Collected</h2>
      <p>
        No information of any kind is collected on this website. I do not
        utilise cookies on this website either.
      </p>

      <h2>Hosting</h2>
      <p>
        The site is served by a hosting provider, which may keep standard
        technical logs (such as IP address, browser type and the pages
        requested) to deliver the site and protect it from abuse. We don’t
        use these logs to identify you.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about privacy: see the{' '}
        <Link to="/reach-us-out">Reach Us Out</Link> page.
      </p>
    </InfoLayout>
  );
}

export function TermsPage() {
  return (
    <InfoLayout title="Terms of Use">
      <h2>Using the tool</h2>
      <p>
        ClipFinder is free to use. By using it, you agree to these terms.
        If you don’t agree with these terms and conditions, please don’t
        use the site.
      </p>

      <h2>Your content</h2>
      <p>
        You keep all rights to your recordings and clips. Only use
        recordings you have the right to use. You’re responsible for
        how you use and share the clips you make.
      </p>

      <h2>No guarantee</h2>
      <p>
        The tool finds clips automatically and can miss a streak or count
        kills wrongly. It’s provided “as is”, so use with your own discretion.
      </p>

      <h2>Open Source Project</h2>
      <p>
        This website is open source under the MIT License, with its code
        openly available on the following{' '}
        <a
          href="https://github.com/KaptainKoopa1309/ClipFinder"
          target="_blank"
          rel="noreferrer"
        >
          GitHub page <ExternalLink size={13} className="inline" />
        </a>.
      </p>

      <h2>Trademarks</h2>
      <p>
        Clips Farming is not affiliated with, endorsed by or sponsored by
        Activision. Call of Duty is a trademark of Activision Publishing, Inc.
      </p>

      <h2>Changes</h2>
      <p>
        We reserve the right to update or modify these terms at any given
        moment without prior notice. Any changes made will be effective
        immediately upon being published to the website.
      </p>

      <h2>Contact</h2>
      <p>
        Questions about these terms: see the{' '}
        <Link to="/reach-us-out">Reach Us Out</Link> page.
      </p>
    </InfoLayout>
  );
}
