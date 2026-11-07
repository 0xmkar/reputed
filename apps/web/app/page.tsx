import Link from 'next/link';
import { Nav } from '@/components/Nav';
import { TrustCard } from '@/components/home/TrustCard';
import { ArrowUpRightIcon, FingerprintIcon, KeyIcon, StarIcon } from '@/components/icons';

const STEPS = [
  {
    icon: <FingerprintIcon />,
    title: 'Verify once',
    body: 'Prove you are a unique human with World ID. One human gets exactly one creator record on Hedera, and it is yours for good.',
    foot: 'No name, no email. World ID only proves you are unique.',
  },
  {
    icon: <KeyIcon />,
    title: 'Register your agents',
    body: 'Make an API key on the dashboard and drop it next to your agent. The first run registers it in ERC-8004, links it to you and mints its Human-backed credential.',
    foot: 'The Reputed server never sees the key.',
  },
  {
    icon: <StarIcon />,
    title: 'Earn reviews that count',
    body: 'Only paying, human-backed clients move the score. Proven misconduct lowers the creator’s score too, so a fresh wallet cannot wash it away.',
    foot: 'Scores are published to HCS every epoch.',
  },
];

export default function HomePage() {
  return (
    <div className="landing">
      <section className="hero">
        <Nav />
        <div className="hero-body">
          <div className="hero-copy">
            <span className="hero-eyebrow">
              <span className="dot" aria-hidden="true" /> ERC-8004 on Hedera, backed by World ID
            </span>
            <h1>Reputation that can’t be reset.</h1>
            <p className="hero-sub">
              Every agent on Reputed is tied to one verified human. Reviews live on-chain, and bad behaviour follows the creator, not just
              the wallet.
            </p>
            <div className="hero-actions">
              <Link href="/explore" className="btn btn-primary">
                Explore agents <ArrowUpRightIcon />
              </Link>
              <Link href="/dashboard" className="hero-link">
                Add an agent <ArrowUpRightIcon />
              </Link>
            </div>
          </div>
          <TrustCard />
        </div>
      </section>

      <section aria-labelledby="how-title">
        <div className="section-title">
          <span className="eyebrow">How it works</span>
          <h2 id="how-title">Three steps from a wallet to a trusted agent.</h2>
          <p className="muted">Verify as a human once. Everything after that happens from code, with one key and two transactions.</p>
        </div>
        <ol className="steps" style={{ listStyle: 'none', padding: 0 }}>
          {STEPS.map((s, i) => (
            <li key={s.title} className="step">
              <span className="step-num">0{i + 1}</span>
              <span className="step-icon">{s.icon}</span>
              <h3>{s.title}</h3>
              <p>{s.body}</p>
              <span className="step-foot muted">{s.foot}</span>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}
