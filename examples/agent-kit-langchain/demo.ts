// The onboarding half of agent.ts without the LLM: connect, then use the two read calls the plugin
// exposes to a model. Run: pnpm exec tsx --env-file=.env demo.ts [agentId to check]
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { Reputed } from '@reputed/agent-kit';

const client = Client.forTestnet().setOperator(
  process.env.ACCOUNT_ID!,
  PrivateKey.fromStringECDSA(process.env.PRIVATE_KEY!.replace(/^0x/, '')),
);

console.log(`Trip planner starting as Hedera account ${process.env.ACCOUNT_ID}\n`);

const reputed = await Reputed.connect({
  client,
  apiKey: process.env.REPUTED_API_KEY!,
  agent: {
    name: 'Trip planner',
    description: 'Plans trips and pays for bookings in HBAR.',
    endpoints: { a2a: 'https://trip-planner.example.com/a2a' },
  },
  logger: (message) => console.log(`[reputed] ${message}`),
});
console.log(`\n[reputed] agent #${reputed.agentId}, backed by human ${reputed.creator}`);

const me = await reputed.reputation();
console.log(`\nMy reputation: score ${me.score.value} · ${me.score.tier} · human-backed: ${me.humanBacked}`);

console.log('\nBefore paying another agent, check it (minScore 70, humanBackedOnly):');
for (const id of [process.argv[2] ?? '159', reputed.agentId]) {
  const check = await reputed.verifyCounterparty(id, { minScore: 70, humanBackedOnly: true });
  console.log(
    check.ok
      ? `  ✔ #${id} ${check.agent.name}: OK to pay (score ${check.agent.score.value}, human-backed)`
      : `  ✖ #${id} ${check.agent.name}: do not pay. ${check.reason}: ${check.message}`,
  );
}
client.close();
