# @reputed/sdk

Check an agent's reputation from code before you pay or hire it, and let LLM agents do the same through an MCP server. Reads only for now; `review()` and `isHumanBacked()` come later.

## Use

```ts
import { ReputedClient, ReputedError } from '@reputed/sdk';

const client = new ReputedClient({ apiUrl: 'http://localhost:4000' }); // optional: timeoutMs (default 10000), fetch

const agent = await client.getAgent('7'); // profile, score, creator, credentials, reviews

const check = await client.verifyCounterparty('7', { minScore: 75, humanBackedOnly: true });
if (!check.ok) console.log(check.reason, check.message); // refuse to pay
```

`getAgent(agentId)` returns the `AgentDetail` from the API.

`verifyCounterparty(agentId, { minScore, humanBackedOnly })` is the gate. It **returns** `{ ok: true, agent }` or `{ ok: false, reason, message, agent }`. It **throws** a `ReputedError` only when the check could not be made.

| `reason` | Meaning |
| --- | --- |
| `AGENT_COMPROMISED` | The creator reported the agent compromised. Always checked |
| `NOT_HUMAN_BACKED` | `humanBackedOnly` is set and no verified human stands behind the agent |
| `SCORE_TOO_LOW` | The score is below `minScore` |

A score equal to `minScore` passes.

### Errors

Anything that is not a gate result is a `ReputedError` with a `code`:

| `code` | Meaning |
| --- | --- |
| `INVALID_ARGUMENT` | A bad agent ID or `minScore`, caught before any request |
| `AGENT_NOT_FOUND` | The API answered 404 |
| `CHAIN_ERROR` | The API reported a Hedera or RPC failure |
| `API_ERROR` | The API was unreachable, did not answer within `timeoutMs` (10 seconds by default), or answered with an unexpected error |

`NOT_HUMAN_BACKED`, `SCORE_TOO_LOW` and `AGENT_COMPROMISED` are the gate reasons above. `PAYMENT_NOT_FOUND` and `SELF_REVIEW` are reserved for `review()`.

## MCP server

`reputed-mcp` serves two tools over stdio: `get_agent` and `verify_counterparty`. Point it at the Reputed server:

```json
{
  "mcpServers": {
    "reputed": {
      "command": "node",
      "args": ["/path/to/reputed/sdk/src/mcp.ts"],
      "env": { "REPUTED_API_URL": "http://localhost:4000" }
    }
  }
}
```

`get_agent` returns a short summary (no reviews). `verify_counterparty` takes `agentId`, optional `minScore` and optional `humanBackedOnly`, and returns `ok` with a `reason` when it is false. Errors come back as tool errors that start with the `ReputedError` code.

## REST

See [docs/rest-api.md](docs/rest-api.md).

## Develop

```sh
pnpm --filter @reputed/sdk typecheck
pnpm --filter @reputed/sdk test
REPUTED_API_URL=http://localhost:4000 node sdk/examples/check-agent.ts 7
```

The package is TypeScript source with erasable syntax only, so Node 22.18 or newer runs it directly. It is `private` until a build step is added for publishing.

Not built yet: `review()` (signs a transaction, owned by the contracts side; the web review modal in `web/components/review` shows the flow) and `isHumanBacked()` (the CreatorRegistry ABI is now in `shared/src/abi`, so this can be built).
