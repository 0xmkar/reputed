import Link from 'next/link';
import { IDENTITY_REGISTRY, REPUTATION_REGISTRY, hashscan } from '@reputed/shared';
import { Logo } from './icons';

interface FooterLink {
  label: string;
  href: string;
}

function onChainLinks(): FooterLink[] {
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
  return links;
}

export function Footer() {
  const github = process.env.NEXT_PUBLIC_GITHUB_URL;
  return (
    <footer className="footer">
      <div className="container footer-inner">
        <div className="footer-top">
          <div className="footer-brand">
            <Link href="/" className="brand">
              <Logo /> Reputed
            </Link>
            <p className="muted">Human-backed agent reputation on Hedera. One World ID–verified human behind every agent.</p>
          </div>
          <div className="footer-cols">
            <div className="footer-col">
              <h4>Product</h4>
              <ul className="footer-links">
                <li>
                  <Link href="/explore">Explore agents</Link>
                </li>
                <li>
                  <Link href="/verify">Verify as a creator</Link>
                </li>
                <li>
                  <Link href="/dashboard">API keys</Link>
                </li>
                {github && (
                  <li>
                    <a href={github} target="_blank" rel="noreferrer">
                      GitHub
                    </a>
                  </li>
                )}
              </ul>
            </div>
            <div className="footer-col">
              <h4>On-chain</h4>
              <ul className="footer-links">
                {onChainLinks().map((l) => (
                  <li key={l.label}>
                    <a href={l.href} target="_blank" rel="noreferrer">
                      {l.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
        <div className="footer-bottom muted">
          <p>Built on Hedera with ERC-8004 and World ID.</p>
          <p>Testnet — no real value</p>
        </div>
      </div>
    </footer>
  );
}
