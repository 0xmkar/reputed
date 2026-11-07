// Run: REPUTED_API_URL=http://localhost:4000 node examples/check-agent.ts <agentId>
import { ReputedClient, ReputedError } from '../src/index.ts';

const client = new ReputedClient({ apiUrl: process.env.REPUTED_API_URL ?? 'http://localhost:4000' });
const agentId = process.argv[2] ?? '1';

try {
  const check = await client.verifyCounterparty(agentId, { minScore: 75, humanBackedOnly: true });
  console.log(check.ok ? `OK to pay ${check.agent.name} (score ${check.agent.score.value})` : `Do not pay: ${check.reason}. ${check.message}`);
} catch (err) {
  if (err instanceof ReputedError) console.error(`${err.code}: ${err.message}`);
  else throw err;
  process.exitCode = 1;
}
