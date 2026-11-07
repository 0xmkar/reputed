import type { ReactNode } from 'react';

interface Props {
  eyebrow?: string;
  title: ReactNode;
  lede?: ReactNode;
  actions?: ReactNode;
}

/** The heading block at the top of every inner page: an eyebrow, the title, one line of context and any actions. */
export function PageHead({ eyebrow, title, lede, actions }: Props) {
  return (
    <div className="page-head">
      <div className="page-head-text">
        {eyebrow && <span className="eyebrow">{eyebrow}</span>}
        <h1>{title}</h1>
        {lede && <p className="lede">{lede}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}
