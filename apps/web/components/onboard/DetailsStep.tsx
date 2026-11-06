'use client';

import { useState, type KeyboardEvent } from 'react';
import { MAX_DESCRIPTION, MAX_NAME, MAX_TAGS, MAX_TAG_LENGTH, detailsComplete, isImageUrl, type AgentFields } from '@/lib/agentFile';
import type { OnboardDraft } from '@/lib/onboardDraft';
import type { PatchDraft } from './OnboardWizard';
import { StepNav } from './StepNav';

interface Props {
  draft: OnboardDraft;
  patch: PatchDraft;
  onNext: () => void;
}

export function DetailsStep({ draft, patch, onNext }: Props) {
  const { fields } = draft;
  const set = (changes: Partial<AgentFields>) => patch({ fields: { ...fields, ...changes } });
  const [tagText, setTagText] = useState('');
  const imageBad = fields.image.trim() !== '' && !isImageUrl(fields.image);

  function addTag() {
    const tag = tagText.trim().toLowerCase().replace(/,+$/, '');
    setTagText('');
    if (tag && !fields.tags.includes(tag) && fields.tags.length < MAX_TAGS) set({ tags: [...fields.tags, tag] });
  }

  function onTagKey(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      addTag();
    } else if (event.key === 'Backspace' && !tagText && fields.tags.length > 0) {
      set({ tags: fields.tags.slice(0, -1) });
    }
  }

  return (
    <div className="card onboard-card">
      <h2>Details</h2>

      <div className="field">
        <label htmlFor="agent-name">Name</label>
        <input
          id="agent-name"
          className="input"
          required
          maxLength={MAX_NAME}
          value={fields.name}
          onChange={(event) => set({ name: event.target.value })}
        />
        <span className="field-hint muted">
          {fields.name.length} / {MAX_NAME}
        </span>
      </div>

      <div className="field">
        <label htmlFor="agent-description">Description</label>
        <textarea
          id="agent-description"
          className="input"
          rows={3}
          maxLength={MAX_DESCRIPTION}
          value={fields.description}
          onChange={(event) => set({ description: event.target.value })}
        />
        <span className="field-hint muted">
          {fields.description.length} / {MAX_DESCRIPTION}
        </span>
      </div>

      <div className="field">
        <label htmlFor="agent-image">Image URL</label>
        <input
          id="agent-image"
          className="input"
          type="url"
          inputMode="url"
          placeholder="https://"
          aria-invalid={imageBad}
          value={fields.image}
          onChange={(event) => set({ image: event.target.value })}
        />
        {imageBad && <span className="field-hint error-text">Use an http, https or ipfs link.</span>}
      </div>

      <div className="field">
        <label htmlFor="agent-tags">Tags</label>
        {fields.tags.length > 0 && (
          <ul className="chips onboard-tags">
            {fields.tags.map((tag) => (
              <li key={tag} className="chip">
                {tag}
                <button
                  type="button"
                  className="onboard-tag-remove"
                  aria-label={`Remove ${tag}`}
                  onClick={() => set({ tags: fields.tags.filter((item) => item !== tag) })}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <input
          id="agent-tags"
          className="input"
          maxLength={MAX_TAG_LENGTH}
          disabled={fields.tags.length >= MAX_TAGS}
          value={tagText}
          onChange={(event) => setTagText(event.target.value)}
          onKeyDown={onTagKey}
          onBlur={addTag}
        />
        <span className="field-hint muted">Press Enter after each tag. Up to {MAX_TAGS}.</span>
      </div>

      <StepNav onNext={onNext} nextDisabled={!detailsComplete(fields)} />
    </div>
  );
}
