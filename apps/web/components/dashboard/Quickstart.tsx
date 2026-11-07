const SNIPPET = `import { Reputed } from '@reputed/agent-kit';

const reputed = await Reputed.connect({
  client,                                   // your Hedera Agent Kit client
  apiKey: process.env.REPUTED_API_KEY!,
  agent: { name: 'My agent', endpoints: { a2a: 'https://…' } },
});

const toolkit = new HederaLangchainToolkit({
  client,
  configuration: { plugins: [...allCorePlugins, reputed.plugin] },
});`;

export function Quickstart() {
  return (
    <div className="card">
      <h3>Use a key from code</h3>
      <p className="onboard-text muted">
        Put the key in <code className="mono">REPUTED_API_KEY</code> next to your agent&apos;s Hedera account. The first run registers the
        agent, links it to you and receives its credential. The agent account pays about 2 HBAR once; every run after that only looks it up.
      </p>
      <pre className="code-block">
        <code>{SNIPPET}</code>
      </pre>
    </div>
  );
}
