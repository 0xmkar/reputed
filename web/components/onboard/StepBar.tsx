import type { WizardStep } from '@/lib/onboardDraft';

const STEPS = ['Details', 'Endpoints', 'Agent wallet', 'Review', 'Link'] as const;

export function StepBar({ current }: { current: WizardStep }) {
  return (
    <ol className="onboard-steps" aria-label={`Step ${current} of ${STEPS.length}`}>
      {STEPS.map((label, index) => {
        const step = index + 1;
        const state = step < current ? 'is-done' : step === current ? 'is-active' : '';
        return (
          <li key={label} className={state} aria-current={step === current ? 'step' : undefined}>
            <span className="onboard-step-mark">{step < current ? '✓' : step}</span>
            <span className="onboard-step-label">{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
