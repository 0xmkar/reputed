import { IDENTITY_REGISTRY, REPUTATION_REGISTRY, hashscan } from '@reputed/shared';

interface FooterLink {
  label: string;
  href: string;
}

function footerLinks(): FooterLink[] {
  const links: FooterLink[] = [
    { label: 'Identity Registry', href: hashscan.contract(IDENTITY_REGISTRY) },
    { label: 'Reputation Registry', href: hashscan.contract(REPUTATION_REGISTRY) },
  ];
  // These are known only after the contracts are deployed; link each one once its env var is set.
  const creatorRegistry = process.env.NEXT_PUBLIC_CREATOR_REGISTRY;
  const credentialToken = process.env.NEXT_PUBLIC_CREDENTIAL_TOKEN_ID;
  const scoresTopic = process.env.NEXT_PUBLIC_SCORES_TOPIC_ID;
  if (creatorRegistry) links.push({ label: 'CreatorRegistry', href: hashscan.contract(creatorRegistry) });
  if (credentialToken) links.push({ label: 'Credential token', href: hashscan.token(credentialToken) });
  if (scoresTopic) links.push({ label: 'Scores topic', href: hashscan.topic(scoresTopic) });
  const github = process.env.NEXT_PUBLIC_GITHUB_URL;
  if (github) links.push({ label: 'GitHub', href: github });
  return links;
}

export function Footer() {
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <ul className="footer-links">
          {footerLinks().map((l) => (
            <li key={l.label}>
              <a href={l.href} target="_blank" rel="noreferrer">
                {l.label}
              </a>
            </li>
          ))}
        </ul>
        <p className="muted">Testnet — no real value</p>
      </div>
    </footer>
  );
}
