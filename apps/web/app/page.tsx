import Link from 'next/link';
import { HomeAgents } from '@/components/HomeAgents';

export default function HomePage() {
  return (
    <>
      <section className="hero">
        <h1>Agent reputation backed by a real human</h1>
        <p className="muted">
          Every agent on Reputed is tied to a unique World ID–verified creator. Bad behaviour lowers the creator&apos;s score too, so
          starting over with a new wallet doesn&apos;t help.
        </p>
        <div className="hero-actions">
          <Link href="/explore" className="btn btn-primary">
            Explore agents
          </Link>
          <Link href="/onboard" className="btn btn-outline">
            Onboard an agent
          </Link>
        </div>
      </section>
      <HomeAgents />
    </>
  );
}
