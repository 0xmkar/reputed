# Reputed — Work Split

Nov 6, 2026

We build the phases in the [implementation plan](02-implementation-plan.md) in order, MVP features first. Swapnil owns the shell and the read-only screens; Atharva owns contracts, backend and everything that signs a transaction.

Statuses below come from the repo and open PRs. "Built" means the code exists, not that it works on testnet: no T-numbered test is recorded as passed. Testnet progress is in the [runbook](06-testnet-runbook.md).

## Who owns what

| Phase | Atharva | Swapnil | Status |
| --- | --- | --- | --- |
| 0 Setup | Repo, ABIs, shared types, test wallets | World ID staging app, `agent-creator-v1` action, `rp_id` and RP signing key | Repo, ABIs and shared types are on `main`. Wallets and the World ID app: see the runbook |
| 1 Contract | CreatorRegistry, HTS credential, deploy | — | Built on `atharva/backend`. Deploy: see the runbook |
| 2 World ID | `POST /api/rp-signature`, `POST /api/verify` | — | Built on `atharva/backend`. Not run with a real IDKit proof, which needs the Verify screen |
| 3 Onboarding | Agent file hosting, on-chain flow | — | `POST /api/agent-file` built on `atharva/backend`. The on-chain flow waits on the Onboard wizard |
| 4 Reviews | HCS topic, `POST /api/review-file` | — | Built on `atharva/backend`. Not run on testnet |
| 5 Scoring | Indexer, scorer, snapshots, read API | — | Built on `atharva/backend`, with one gap: the read API does not yet return `status`, `acceptsX402`, credential `kind`, `scoresStale`, `nextHalvingAt` or penalty `reports`, so the server fails `pnpm typecheck` |
| 6 Web | Verify, Onboard and Leave a review (the signing flows) | App shell, shared components, Home, Agent page, Creator profile, Explorer | Atharva's screens are not built. Swapnil's are in open PRs #2–#6 and #9 |
| 7 SDK | `review()` | SDK reads, REST docs, MCP server | `review()` is not built. Reads, REST docs and the MCP server are in open PR #8 |
| 8 Demo | Hardening, full demo run | Phone-width test, demo script, README | Not finished. README is in open PR #10, and the phone-width CSS fixes in open PR #9 |

`atharva/backend` is not on `main` yet and has no PR.

## Swapnil's task list, in order

Each task is one PR. Screen details are in [UI Elements](04-ui-elements.md).

1. **World ID app.** In the Developer Portal, create a staging app and the action `agent-creator-v1`, limited to one verification per person. Capture the `app_id`, the `rp_id` and the RP signing key. The portal shows the signing key only once, so save it when it appears. Send Atharva all three, and note whether the Simulator emits protocol 3.0 or 4.0, because the server accepts only one. The `app_id` and `rp_id` are public. The signing key is a server secret: send it privately, never in a PR, an issue or a `NEXT_PUBLIC_` value. **Status:** nothing in the repo shows this as done.
2. **App shell.** A Next.js App Router project in `web/`, using wagmi and viem with Hedera testnet from `@reputed/shared`. Add `transpilePackages: ['@reputed/shared']` to `next.config`. Include the header, wallet button, network pill, wrong-network banner with Switch, footer and toasts. **Status:** PR #2 open.
3. **Shared components.** Score ring, tier badge, Human-backed badge, Verified creator badge, credential card, review card, address chip, transaction button, cost hint and empty state. **Status:** PR #3 open.
4. **Home and Explorer** (`/`, `/explore`), from `GET /api/agents`. **Status:** PR #4 open.
5. **Agent page** (`/agent/[agentId]`), from `GET /api/agents/:agentId`. Leave a slot for the review modal, which Atharva adds. **Status:** PR #5 open.
6. **Creator profile** (`/creator/[address]`), from `GET /api/creators/:address`. **Status:** PR #6 open.

## Rules for both of us

- **No fake data.** Screens call the real API through `NEXT_PUBLIC_API_URL` and show their loading, empty and error states until it answers. No hard-coded agents, no mock mode, no simulated scores.
- **Stay in your folders.** Swapnil works in `web/` and later `sdk/`. Atharva works in `contracts/`, `server/` and `shared/`, plus `web/app/verify`, `web/app/onboard` and the review modal once the shell is merged.
- **`shared/src/api.ts` is the contract between `server/` and `web/`.** Build against it. If a field is missing, tell Atharva rather than working around it.
- **Branches and PRs.** Use `swapnil/<task>` or `atharva/<task>`. Everything reaches `main` through a PR that the other person reviews and merges. Keep PRs small so review is quick.
- **Secrets.** Keys, including the RP signing key, stay in the gitignored `.env`. The browser only ever gets `NEXT_PUBLIC_` values.
