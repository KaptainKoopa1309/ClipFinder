import { useState } from 'react';
import {
  ArrowLeft,
  ArrowUpRight,
  Instagram,
  Mail,
  Send,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import { CONTACT_EMAIL } from '../constants';

const fieldClass =
  'w-full rounded-xl border border-line bg-[#101511] px-4 py-3.5 text-sm text-white outline-none placeholder:text-[#68736b] transition-all focus:border-green focus:ring-2 focus:ring-green/10';

const labelClass =
  'mb-2 block text-[11px] font-semibold uppercase tracking-[0.12em] text-[#9ca99f]';

const contactCardClass =
  'group flex min-w-0 items-center gap-3 rounded-xl border border-line bg-[#0d110e] p-4 transition-colors hover:border-[#31563b] hover:bg-[#111812]';

export default function ReachUsOutPage() {
  const [message, setMessage] = useState('');
  const [emailLinks, setEmailLinks] = useState(null);

  const handleSubmit = (event) => {
    event.preventDefault();

    if (message.trim().length < 5) return;

    const subject = 'Message for ClipFinder';
    const body = [
      'Hi ClipFinder team,',
      '',
      message.trim(),
      '',
      'Sent from ClipFinder.',
    ].join('\n');

    const params = new URLSearchParams({
      view: 'cm',
      fs: '1',
      to: CONTACT_EMAIL,
      su: subject,
      body,
    });

    const gmailUrl = `https://mail.google.com/mail/?${params.toString()}`;
    const mailtoUrl = `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    window.open(gmailUrl, '_blank', 'noopener,noreferrer');
    setEmailLinks({ gmailUrl, mailtoUrl });
  };

  return (
    <main className="homepage-enter mx-auto w-full max-w-3xl px-4 pb-12 sm:px-6">

      {/* Back navigation */}
      <Link
        to="/"
        className="mb-5 inline-flex min-h-10 items-center gap-2 text-sm font-medium text-muted transition-colors hover:text-green-text"
      >
        <ArrowLeft size={15} />
        Back to ClipFinder
      </Link>

      <section className="overflow-hidden rounded-2xl border border-line bg-panel shadow-[0_12px_40px_rgba(0,0,0,0.2)]">

        {/* Header */}
        <header className="relative overflow-hidden border-b border-line bg-[radial-gradient(ellipse_at_top_left,rgba(34,197,94,0.12),transparent_65%),#0e1210] px-6 py-8 sm:px-8 sm:py-10">

          <div className="mb-5 flex h-11 w-11 items-center justify-center rounded-xl border border-[#31563b] bg-green/10 text-green">
            <Mail size={20} />
          </div>

          <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-green-text">
            CONTACT
          </p>

          <h1 className="mt-2 text-3xl font-bold tracking-tight text-white sm:text-4xl">
            Get in touch<span className="text-green">.</span>
          </h1>
        </header>

        {/* Contact options */}
        <div className="space-y-4 border-b border-line p-5 sm:p-7">

          <div className="flex items-center justify-between">
            <h2 className="text-xs font-bold uppercase tracking-[0.12em] text-[#a5b0a8]">
              Contact options
            </h2>
          </div>

          <a
            href={`mailto:${CONTACT_EMAIL}`}
            className={contactCardClass}
          >
            <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-green/10 text-green">
              <Mail size={18} />
            </div>

            <div className="min-w-0 flex-1">
              <p className="text-[11px] font-medium text-muted">
                Email
              </p>
              <p className="mt-0.5 break-all text-sm font-semibold text-white transition-colors group-hover:text-green-text">
                {CONTACT_EMAIL}
              </p>
            </div>

            <ArrowUpRight size={17} className="shrink-0 text-muted transition-colors group-hover:text-green" />
          </a>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">

            <a
              href="https://www.instagram.com/luigicodm_13/"
              target="_blank"
              rel="noopener noreferrer"
              className={contactCardClass}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#181b19] text-white">
                <Instagram size={18} />
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-muted">
                  Instagram
                </p>
                <p className="mt-0.5 truncate text-sm font-semibold text-white">
                  @luigicodm_13
                </p>
              </div>

              <ArrowUpRight size={16} className="shrink-0 text-muted transition-colors group-hover:text-green" />
            </a>

            <a
              href="https://x.com/Weegiethfc"
              target="_blank"
              rel="noopener noreferrer"
              className={contactCardClass}
            >
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#181b19] text-white font-bold text-lg">
                X
              </div>

              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-medium text-muted">
                  Twitter / X
                </p>
                <p className="mt-0.5 truncate text-sm font-semibold text-white">
                  @Weegiethfc
                </p>
              </div>

              <ArrowUpRight size={16} className="shrink-0 text-muted transition-colors group-hover:text-green" />
            </a>

          </div>

          {/* Bug report guidance */}
          <div className="flex gap-3 rounded-xl border border-[#31563b]/50 bg-green/5 p-4">
            <div className="mt-0.5 shrink-0 text-green">
              <Send size={16} />
            </div>

            <div>
              <p className="text-sm font-semibold text-white">
                Reporting a clip issue?
              </p>
              <p className="mt-1 text-xs leading-5 text-muted">
                Include your recording mode (Live or Replay), device and browser. No video attachment needed.
              </p>
            </div>
          </div>

        </div>

        {/* Message form */}
        <div className="p-5 sm:p-7">

          <div className="mb-5">
            <h2 className="text-xl font-bold tracking-tight text-white">
              Send a message
            </h2>
            <div className="mt-2 h-1 w-10 rounded-full bg-green" />
          </div>

          <form onSubmit={handleSubmit} className="space-y-4">

            <div>
              <label htmlFor="reach-message" className={labelClass}>
                Message
              </label>

              <textarea
                id="reach-message"
                required
                minLength={5}
                maxLength={5000}
                rows={6}
                value={message}
                onChange={(event) => {
                  setMessage(event.target.value);
                  setEmailLinks(null);
                }}
                placeholder="Describe the issue or share your idea..."
                className={`${fieldClass} min-h-44 resize-y leading-6`}
              />

              <p className="mt-2 text-right text-[11px] tabular-nums text-[#778078]">
                {message.length}/5000
              </p>
            </div>

            <div className="flex flex-col gap-3 sm:flex-row sm:items-center">

              <button
                type="submit"
                className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl bg-green px-6 py-3 text-sm font-bold text-[#041209] transition-all hover:bg-green-dark hover:shadow-[0_0_20px_rgba(34,197,94,0.15)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-green"
              >
                <Send size={16} />
                Create email draft
              </button>

              <p className="text-xs leading-5 text-muted">
                Review and send from your email app.
              </p>

            </div>

            {emailLinks && (
              <div
                role="status"
                aria-live="polite"
                className="rounded-xl border border-[#31563b] bg-green/5 p-4"
              >
                <p className="text-sm font-semibold text-green-text">
                  Your email draft is ready
                </p>

                <p className="mt-1 text-xs leading-5 text-muted">
                  Didn't open automatically? Choose an option below.
                </p>

                <div className="mt-3 flex flex-wrap gap-4 text-xs font-semibold">
                  <a
                    href={emailLinks.gmailUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-green-text underline underline-offset-4 hover:text-green"
                  >
                    Open Gmail
                  </a>

                  <a
                    href={emailLinks.mailtoUrl}
                    className="text-green-text underline underline-offset-4 hover:text-green"
                  >
                    Open email app
                  </a>
                </div>
              </div>
            )}

          </form>
        </div>

      </section>
    </main>
  );
}
