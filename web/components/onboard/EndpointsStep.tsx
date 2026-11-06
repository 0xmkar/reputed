'use client';

import { endpointsComplete, isLinkUrl, isValidPrice, type AgentFields } from '@/lib/agentFile';
import type { OnboardDraft } from '@/lib/onboardDraft';
import type { PatchDraft } from './OnboardWizard';
import { StepNav } from './StepNav';

interface Props {
  draft: OnboardDraft;
  patch: PatchDraft;
  onBack: () => void;
  onNext: () => void;
}

const URL_FIELDS = [
  { key: 'a2a', label: 'A2A URL' },
  { key: 'mcp', label: 'MCP URL' },
  { key: 'web', label: 'Website URL' },
] as const;

export function EndpointsStep({ draft, patch, onBack, onNext }: Props) {
  const { fields } = draft;
  const set = (changes: Partial<AgentFields>) => patch({ fields: { ...fields, ...changes } });
  const empty = URL_FIELDS.every(({ key }) => !fields[key].trim());
  const priceBad = fields.x402 && fields.x402Price.trim() !== '' && !isValidPrice(fields.x402Price);

  return (
    <div className="card onboard-card">
      <h2>Endpoints</h2>

      {URL_FIELDS.map(({ key, label }) => {
        const bad = fields[key].trim() !== '' && !isLinkUrl(fields[key]);
        return (
          <div className="field" key={key}>
            <label htmlFor={`agent-${key}`}>{label}</label>
            <input
              id={`agent-${key}`}
              className="input"
              type="url"
              inputMode="url"
              placeholder="https://"
              aria-invalid={bad}
              value={fields[key]}
              onChange={(event) => set({ [key]: event.target.value })}
            />
            {bad && <span className="field-hint error-text">Enter a full http or https URL.</span>}
          </div>
        );
      })}
      {empty && <p className="onboard-text muted">Add at least one endpoint.</p>}

      <label className="check">
        <input type="checkbox" checked={fields.x402} onChange={(event) => set({ x402: event.target.checked })} />
        Accepts x402 payments
      </label>

      {fields.x402 && (
        <div className="field">
          <label htmlFor="agent-price">Price per call (HBAR)</label>
          <input
            id="agent-price"
            className="input"
            inputMode="decimal"
            aria-invalid={priceBad}
            value={fields.x402Price}
            onChange={(event) => set({ x402Price: event.target.value })}
          />
          {priceBad && <span className="field-hint error-text">Enter an amount above 0, with up to 8 decimal places.</span>}
        </div>
      )}

      <StepNav onBack={onBack} onNext={onNext} nextDisabled={!endpointsComplete(fields)} />
    </div>
  );
}
