# @reputed/agent-kit

Give an agent built with the [Hedera Agent Kit](https://github.com/hashgraph/hedera-agent-kit-js) a Reputed identity. You need one thing from the dashboard, an API key. The first run registers the agent, links it to the verified human behind the key and receives its Human-backed credential. Every run after that only looks it up.

```ts
import { Reputed } from '@reputed/agent-kit';

const reputed = await Reputed.connect({
  client,                                         // your Hedera Client, with the agent's operator account
  apiKey: process.env.REPUTED_API_KEY!,           // from /dashboard
  agent: { name: 'Trip planner', endpoints: { a2a: 'https://…' } },
});

const toolkit = new HederaLangchainToolkit({
  client,
  configuration: { plugins: [...allCorePlugins, reputed.plugin], context: { mode: AgentMode.AUTONOMOUS } },
});
```

A full agent is in [`examples/agent-kit-langchain`](../../examples/agent-kit-langchain/agent.ts). It differs from the Agent Kit's own example by the `Reputed.connect` call and `reputed.plugin`.

## What you need

- A Hedera `Client` with an operator. That account **is** the agent: it owns the agent NFT and receives the credential. Give each agent its own account.
- About 6 HBAR on that account for the first run (register ≈ 1.9 HBAR, link ≈ 1.9 HBAR, a token association if needed; Hedera charges gas used, but the balance has to cover the limit). `INSUFFICIENT_HBAR` says how much is missing.
- An API key. A verified creator makes one on the dashboard (`/dashboard`) and authorizes it with one wallet transaction.
- `REPUTED_API_URL` (or the `apiUrl` option): where the Reputed server runs.

## What the first run does

1. Reads the key's grant from CreatorRegistry. A key that is unknown, revoked, expired or used up is refused **before** anything is registered.
2. Registers the agent in the ERC-8004 Identity Registry (reusing one this account already registered under the same name, or the one you pass as `agentId`).
3. Associates the credential token if the account has no free automatic-association slots.
4. Signs `LinkGrant(agentId, owner, deadline)` with the key and calls `linkAgentWithGrant`. The agent's account sends it and pays the gas. The credential arrives frozen in that account.

Progress is written to `.reputed/state.json` (change it with `state`, or pass `false` for memory only) **before** each transaction is sent. If the process dies, run it again: it finds what already happened on-chain and carries on, and it never registers a second agent. Add `.reputed/` to `.gitignore`. It holds no secrets, only IDs.

## The plugin

`reputed.plugin` adds three read-only tools to the Agent Kit:

| Tool | Does |
| --- | --- |
| `reputed_my_reputation` | The agent's own score, tier, human-backed status and credentials |
| `reputed_get_agent` | Another agent's summary, by agent ID |
| `reputed_verify_counterparty` | `{ agentId, minScore?, humanBackedOnly? }` → `ok`, or the reason not to pay. The model is told to call it before sending any payment |

Without the Agent Kit, use `reputed.reputation()` and `reputed.verifyCounterparty(agentId, { minScore, humanBackedOnly })`.

## How the key works

The key is 32 random bytes made in the creator's browser: `rpk_test_<base64url>`. A signing key is derived from it, and only that key's **address** goes on Hedera, through `authorizeGrant(address, expiresAt, maxAgents)`. The Reputed server never sees the key, so it cannot link an agent to anyone. A leaked key can link at most `maxAgents` agents before it expires, and the creator can revoke it or report any agent it linked. The contract side is in [packages/contracts/README.md](../contracts/README.md#grants-linking-without-the-creators-wallet).

## Errors

Everything thrown is a `ReputedAgentError` with a `code`:

| `code` | Meaning |
| --- | --- |
| `INVALID_API_KEY` | Not an `rpk_…` key |
| `NO_OPERATOR` | The `Client` has no operator account |
| `NOT_CONFIGURED` | No API URL, or the server has no CreatorRegistry yet |
| `API_ERROR`, `MIRROR_ERROR` | The Reputed API or the Mirror Node was unreachable |
| `GRANT_NOT_FOUND` | The key was never authorized on-chain (or its transaction is still settling) |
| `GRANT_REVOKED`, `GRANT_EXPIRED`, `GRANT_EXHAUSTED` | Make a new key |
| `INSUFFICIENT_HBAR` | The agent account cannot pay for the next transaction |
| `LINKED_TO_OTHER_CREATOR` | The agent already belongs to a different human |
| `OWNER_MISMATCH` | The registry's owner is not the account you passed |
| `TRANSACTION_FAILED`, `TIMEOUT` | Hedera rejected or reverted a transaction, or its result never showed up |

## Limits

- An agent linked this way cannot use `syncAgentWallet` to rotate its wallet. Onboard a new agent instead.
- Reviews (`review()`) are not in this package yet.
- The package is TypeScript source, like `@reputed/sdk`, and is `private` until a build step is added for publishing.

## Develop

```sh
pnpm --filter @reputed/agent-kit typecheck
pnpm --filter @reputed/agent-kit test
```

The tests run the whole onboarding against an in-memory chain (`test/fakeChain.ts`) that recovers the grant signature the way the contract does, including crashes at each step.
