
import { CheckCircle2, ChevronDown, Info } from 'lucide-react';

const steps = [
  {
    title: 'Select your recording',
    description: 'Choose your COD Mobile Multiplayer match video.',
  },
  {
    title: 'Choose recording mode',
    description: 'Select Live Match or Replay Mode.',
  },
  {
    title: 'Set minimum kills',
    description: 'Choose the minimum number of kills required per clip.',
  },
  {
    title: 'Review your clips',
    description: 'Preview detected clips and download the ones you want.',
  },
];

const tips = [
  'Works best in Chrome or Edge.',
  'Clips retain the original video quality.',
  'Results are prioritised by kill count and timing.',
  'Detection can occasionally miss or misread kills.',
];

export default function HowItWorks() {
  return (
    <section className="mt-8 space-y-7">

      {/* Introduction */}
      <div>        
        <h2 className="mt-2 text-xl font-semibold tracking-tight text-white sm:text-2xl">
          Find your best clips
        </h2>

        <p className="cf-description mt-2 max-w-2xl">
          Scan your COD Mobile recordings for multi-kill streaks.
          Preview your results and save clips locally to your device.
        </p>
      </div>

      {/* Instructions */}
      <div>
        <h3 className="cf-section-title mb-2">
          How it works
        </h3>

        <ol>
          {steps.map((step, index) => (
            <li
              key={step.title}
              className="flex gap-4 border-b border-[#232B25] py-4 last:border-b-0"
            >
              <span className="w-6 shrink-0 pt-0.5 text-xs font-semibold tabular-nums text-green">
                {String(index + 1).padStart(2, '0')}
              </span>

              <div className="min-w-0">
                <h4 className="text-sm font-semibold leading-5 text-[#E8EDE9]">
                  {step.title}
                </h4>

                <p className="mt-1 text-sm leading-6 text-[#A0AAA2]">
                  {step.description}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>

      {/* Expandable information */}
      <details className="group border-t border-[#29312B] pt-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center justify-between gap-3 [&::-webkit-details-marker]:hidden">
          <span className="flex items-center gap-2 text-sm font-medium text-[#DCE3DD]">
            <Info size={16} className="text-[#9DA99F]" />
            Tips and accuracy
          </span>

          <ChevronDown
            size={16}
            className="text-[#859087] transition-transform duration-150 group-open:rotate-180"
          />
        </summary>

        <div className="pt-4">
          <ul className="space-y-3">
            {tips.map((tip) => (
              <li
                key={tip}
                className="flex items-start gap-3 text-sm leading-6 text-[#A0AAA2]"
              >
                <CheckCircle2
                  size={15}
                  className="mt-1 shrink-0 text-green"
                />
                <span>{tip}</span>
              </li>
            ))}
          </ul>

          <p className="mt-5 border-l-2 border-[#39443C] pl-3 text-sm leading-6 text-[#A0AAA2]">
            Always review generated timestamps and previews before
            editing or sharing your clips. Contact us if calibration
            fails or a clip is missed.
          </p>
        </div>
      </details>

    </section>
  );
}
