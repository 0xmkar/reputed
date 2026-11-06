import { AgentMode } from '@hashgraph/hedera-agent-kit';
import { allCorePlugins } from '@hashgraph/hedera-agent-kit/plugins';
import { HederaLangchainToolkit } from '@hashgraph/hedera-agent-kit-langchain';
import { Client, PrivateKey } from '@hiero-ledger/sdk';
import { ChatOpenAI } from '@langchain/openai';
import { createAgent } from 'langchain';
import { Reputed } from '@reputed/agent-kit';

// This is the Hedera Agent Kit's LangChain example. The only Reputed parts are the import above,
// the Reputed.connect call, and `reputed.plugin` in the plugin list.

const client = Client.forTestnet().setOperator(
  process.env.ACCOUNT_ID!,
  PrivateKey.fromStringECDSA(process.env.PRIVATE_KEY!),
);

// First run: registers the agent, links it to the human behind the API key and receives its
// credential (a minute or so). Every run after that only looks it up.
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
console.log(`[reputed] agent #${reputed.agentId}, backed by ${reputed.creator}`);

const toolkit = new HederaLangchainToolkit({
  client,
  configuration: {
    plugins: [...allCorePlugins, reputed.plugin],
    context: { mode: AgentMode.AUTONOMOUS },
  },
});

const agent = createAgent({
  model: new ChatOpenAI({ model: 'gpt-4.1' }),
  tools: toolkit.getTools(),
  systemPrompt:
    'You are a travel agent that can pay other agents in HBAR. Before paying any agent, check it with reputed_verify_counterparty (humanBackedOnly: true, minScore: 70) and refuse to pay if it fails.',
});

const answer = await agent.invoke({
  messages: [{ role: 'user', content: process.argv[2] ?? 'How trustworthy are you? Then check agent #1 before I pay it 5 HBAR.' }],
});
console.log(answer.messages.at(-1)?.content);
