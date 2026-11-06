import { CheckIcon } from '@/components/icons';

const STEPS = ['Connect wallet', 'Verify with World ID', 'Done'];

/** `current` is the index of the active step. When it is the last, every step is complete. */
export function StepIndicator({ current }: { current: number }) {
  const finished = current === STEPS.length - 1;
  return (
    <ol className="verify-steps">
      {STEPS.map((label, index) => {
        const done = index < current || finished;
        const active = index === current && !finished;
        return (
          <li
            key={label}
            className={done ? 'is-done' : active ? 'is-active' : undefined}
            aria-current={index === current ? 'step' : undefined}
          >
            <span className="verify-step-mark">{done ? <CheckIcon /> : index + 1}</span>
            <span>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}
