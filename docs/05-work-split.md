# Reputed — Work Split

Nov 6, 2026

We build the phases in the [implementation plan](02-implementation-plan.md) in order, MVP features first. Swapnil owns the shell and the read-only screens; Atharva owns contracts, backend and everything that signs a transaction.

## Who owns what

| Phase | Atharva | Swapnil |
| --- | --- | --- |
| 0 Setup | Repo, ABIs, shared types, test wallets | World ID staging app and `agent-creator-v1` action |
| 1 Contract | CreatorRegistry, HTS credential, deploy | — |
| 2 World ID | `POST /api/verify` | — |
| 3 Onboarding | Agent file hosting, on-chain flow | — |
| 4 Reviews | HCS topic, `POST /api/review-file` | — |
| 5 Scoring | Indexer, scorer, snapshots, read API | — |
| 6 Web | Verify, Onboard and Leave a review (the signing flows) | App shell, shared components, Home, Agent page, Creator profile, Explorer |
| 7 SDK | `review()` | SDK reads, REST docs, MCP server |
| 8 Demo | Hardening, full demo run | Phone-width test, demo script, README |

## Swapnil's task list, in order

Each task is one PR. Screen details are in [UI Elements](04-ui-elements.md).

1. **World ID app.** In the Developer Portal, create a staging app and the action `agent-creator-v1`, limited to one verification per person. Send Atharva the `app_id`, which is public.
2. **App shell.** A Next.js App Router project in `web/`, using wagmi and viem with Hedera testnet from `@reputed/shared`. Add `transpilePackages: ['@reputed/shared']` to `next.config`. Include the header, wallet button, network pill, wrong-network banner with Switch, footer and toasts.
3. **Shared components.** Score ring, tier badge, Human-backed badge, Verified creator badge, credential card, review card, address chip, transaction button, cost hint and empty state.
4. **Home and Explorer** (`/`, `/explore`), from `GET /api/agents`.
5. **Agent page** (`/agent/[agentId]`), from `GET /api/agents/:agentId`. Leave a slot for the review modal, which Atharva adds.
6. **Creator profile** (`/creator/[address]`), from `GET /api/creators/:address`.

## Rules for both of us

- **No fake data.** Screens call the real API through `NEXT_PUBLIC_API_URL` and show their loading, empty and error states until it answers. No hard-coded agents, no mock mode, no simulated scores.
- **Stay in your folders.** Swapnil works in `web/` and later `sdk/`. Atharva works in `contracts/`, `server/` and `shared/`, plus `web/app/verify`, `web/app/onboard` and the review modal once the shell is merged.
- **`shared/src/api.ts` is the contract between `server/` and `web/`.** Build against it. If a field is missing, tell Atharva rather than working around it.
- **Branches and PRs.** Use `swapnil/<task>` or `atharva/<task>`. Everything reaches `main` through a PR that the other person reviews and merges. Keep PRs small so review is quick.
- **Secrets.** Keys stay in the gitignored `.env`. The browser only ever gets `NEXT_PUBLIC_` values.
