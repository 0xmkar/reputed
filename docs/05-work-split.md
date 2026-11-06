# Reputed — Work Split

Nov 6, 2026

We build the phases in the [implementation plan](02-implementation-plan.md) in order, MVP features first. Swapnil owns the shell and the read-only screens; Atharva owns contracts, backend and everything that signs a transaction.

Statuses below come from the repo on `main` (all 13 PRs are merged and no branch is waiting). "Built" means the code exists, typechecks and passes unit tests, not that it works against a live World ID app. Testnet progress is in the [runbook](06-testnet-runbook.md). What is left, and the order to do it in, is in the [Completion Plan](07-completion-plan.md).

## Who owns what

| Phase | Atharva | Swapnil | Status |
| --- | --- | --- | --- |
| 0 Setup | Repo, ABIs, shared types, test wallets | World ID staging app, `agent-creator-v1` action, `rp_id` and RP signing key | Repo, ABIs and shared types are on `main`. **Open:** the World ID app. Nothing in the repo shows it done |
| 1 Contract | CreatorRegistry, HTS credential, deploy | — | Done and deployed on testnet; source verified. Issuer job for stale credentials not built |
| 2 World ID | `POST /api/rp-signature`, `POST /api/verify` | — | Server and Verify screen built. **Open:** never run with a real IDKit proof (T2.1–T2.8), which needs the World ID app |
| 3 Onboarding | Agent file hosting, on-chain flow | — | `POST /api/agent-file` and the Onboard wizard built. The server side ran on testnet through `testnet-phase3.ts`. **Open:** the wizard has not been run end to end in a browser |
| 4 Reviews | HCS topic, `POST /api/review-file` | — | Built; T4.1–T4.9 passed on testnet. The review modal is built and has not been run in a browser |
| 5 Scoring | Indexer, scorer, snapshots, read API | — | Built; T5.1–T5.5, T5.8 and T8.3 passed on testnet. The read API fields (`status`, `acceptsX402`, credential `kind`, `scoresStale`, penalty `reports`) are on `main` and the server typechecks. **Open:** T5.6, T5.7, T5.9 |
| 6 Web | Verify, Onboard, Leave a review, report-compromised | App shell, shared components, Home, Agent page, Creator profile, Explorer | All screens are on `main`. The signing flows were merged as a WIP branch and are **not reviewed** |
| 7 SDK | `review()` | SDK reads, REST docs, MCP server | Reads, REST docs and the MCP server are on `main`. **Open:** `review()` and `isHumanBacked()` |
| 8 Demo | Hardening, full demo run | Phone-width test, demo script, README | README and the narrow-screen CSS are on `main`. **Open:** T8.1, T8.2, the demo video, hardening |

## Swapnil's task list, in order

Each task was one PR. Tasks 2–6 are merged; task 1 is the only one left. Screen details are in [UI Elements](04-ui-elements.md).

1. **World ID app.** In the Developer Portal, create a staging app and the action `agent-creator-v1`, limited to one verification per person. Capture the `app_id`, the `rp_id` and the RP signing key. The portal shows the signing key only once, so save it when it appears. Send Atharva all three, and note whether the Simulator emits protocol 3.0 or 4.0, because the server accepts only one. The `app_id` and `rp_id` are public. The signing key is a server secret: send it privately, never in a PR, an issue or a `NEXT_PUBLIC_` value. **Status:** nothing in the repo shows this as done.
2. **App shell.** A Next.js App Router project in `web/`, using wagmi and viem with Hedera testnet from `@reputed/shared`. Add `transpilePackages: ['@reputed/shared']` to `next.config`. Include the header, wallet button, network pill, wrong-network banner with Switch, footer and toasts. **Status:** done (PR #2).
3. **Shared components.** Score ring, tier badge, Human-backed badge, Verified creator badge, credential card, review card, address chip, transaction button, cost hint and empty state. **Status:** done (PR #3).
4. **Home and Explorer** (`/`, `/explore`), from `GET /api/agents`. **Status:** done (PR #4).
5. **Agent page** (`/agent/[agentId]`), from `GET /api/agents/:agentId`. Leave a slot for the review modal, which Atharva adds. **Status:** done (PR #5).
6. **Creator profile** (`/creator/[address]`), from `GET /api/creators/:address`. **Status:** done (PR #6).

## Rules for both of us

- **No fake data.** Screens call the real API through `NEXT_PUBLIC_API_URL` and show their loading, empty and error states until it answers. No hard-coded agents, no mock mode, no simulated scores.
- **Stay in your folders.** Swapnil works in `web/` and later `sdk/`. Atharva works in `contracts/`, `server/` and `shared/`, plus `web/app/verify`, `web/app/onboard` and the review modal once the shell is merged.
- **`shared/src/api.ts` is the contract between `server/` and `web/`.** Build against it. If a field is missing, tell Atharva rather than working around it.
- **Branches and PRs.** Use `swapnil/<task>` or `atharva/<task>`. Everything reaches `main` through a PR that the other person reviews and merges. Keep PRs small so review is quick.
- **Secrets.** Keys, including the RP signing key, stay in the gitignored `.env`. The browser only ever gets `NEXT_PUBLIC_` values.
