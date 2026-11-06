# Reputed — Completion Plan

Nov 6, 2026

All code PRs are merged and `main` typechecks, builds and passes its unit tests. What is left is mostly proving the signing flows against a real World ID app and testnet, a few missing features, hardening and the demo. This plan lists it in the order to do it. Owners follow the [Work Split](05-work-split.md); test IDs are from the [implementation plan](02-implementation-plan.md).

## Where we are

| Area | State |
| --- | --- |
| Contracts, verifier, reviews, scorer, read API | Built and deployed. Phases 1, 3 (server side), 4, 5 ran on testnet with test-only creators |
| Read-only screens (Home, Explorer, Agent, Creator) | Built, merged, narrow-screen fixed |
| Signing flows (Verify, Onboard, review modal, report-compromised) | Merged from a branch whose last commit was labelled "WIP, not reviewed yet". Never run in a browser against a real World ID app |
| SDK reads, REST docs, MCP server | Built and merged |
| World ID staging app | **Not created** (nothing in the repo shows it) |

## The order

Each step names its owner, what blocks it and how to know it is done.

### 1. World ID app (Swapnil) — blocks everything in steps 3 to 6

- Create the staging app and the action `agent-creator-v1`, one verification per person (T0.5).
- Capture `app_id`, `rp_id` and the RP signing key. The key is shown once. Note whether the Simulator emits protocol 3.0 or 4.0.
- Send the signing key to Atharva privately. Set `WORLD_RP_ID`, `RP_SIGNING_KEY`, `WORLD_ENVIRONMENT`, `WORLD_PROTOCOL_VERSION` on the server and `NEXT_PUBLIC_WORLD_APP_ID`, `NEXT_PUBLIC_WORLD_ACTION` in `web/.env.local`.
- **Done when:** T0.5 passes and `POST /api/rp-signature` returns a context that IDKit accepts.

### 2. Review the signing flows (Atharva wrote them, Swapnil reviews) — can run in parallel with step 1

They were merged unreviewed, which breaks our own rule that the other person reviews every PR.

- Read `web/components/verify`, `onboard`, `review` and `creator/ReportCompromised.tsx` against [UI Elements](04-ui-elements.md) and the signing rules in the runbook (wallet signature over `walletBindingMessage`, 1,500,000 gas limit on `linkAgent` and `syncAgentWallet`, resume after a closed tab).
- Note that `pnpm test` currently runs tests only in `sdk` and `server`, so nothing automatic covers the web flows. Add tests for the pure helpers (`reviewFile`, `onboardDraft`, `worldRequest`) if time allows; the rest is covered by the browser runs below.
- Fix findings in small PRs.
- **Done when:** the review is written down and its findings are fixed or ticketed.

### 3. Phase 2 with real proofs: T2.1–T2.8 (Atharva and Swapnil)

- Start the server (runbook step 10) behind ngrok, point `web` at it, and run the Verify screen with the World ID Simulator and then a real Orb-verified human if one is available.
- Check each of T2.1–T2.8, including a second creator record for the same human being refused (the demo's step 5 depends on it) and `WALLET_TAKEN` on a reused wallet.
- **Done when:** T2.1–T2.8 pass and are recorded in the runbook's results table.

### 4. Phase 3 in a browser: T3.1–T3.9

- Run the Onboard wizard end to end with the creators from step 3, not the test-only ones. Check the credential shows frozen on HashScan, the saved-progress resume works, and a wallet with no free association slots hits the T3.6 revert.
- Check real gas use against the contracts README limits (the runbook lists this as unobserved).
- **Done when:** T3.1–T3.9 pass and are recorded.

### 5. Phase 4 and 5 gaps: reviews through the UI, T5.6, T5.7, T5.9

- Leave a review from the modal as a human-backed creator. Check the payment check, the signature and that the review reaches the HCS topic and the agent page.
- T5.6 needs two more creators because of the reporter cooldown, so register them in step 3. Run T5.7 and T5.9 on testnet; unit tests cover them today.
- Check `TRUST_PROXY` through a real ngrok hop with a spoofed `X-Forwarded-For`, and contract key authority (T1.2, T1.6).
- **Done when:** all of T4.x and T5.x have a testnet result.

### 6. Missing features (Atharva)

| Item | What | Why |
| --- | --- | --- |
| SDK `review()` | Sign and post a review file, same flow as the modal | Agents leave reviews without a browser. `web/components/review/reviewFile.ts` and `@reputed/shared` already hold the signing logic |
| SDK `isHumanBacked()` | Read from the CreatorRegistry. The ABI is in `shared/src/abi` now, so the old blocker is gone | Listed as not built in `sdk/README.md` |
| Credential issuer job (CD-4) | Revoke a credential after a sale, rotation or compromise report | Until then a stale wallet keeps a frozen NFT. `humanBacked` from the API stays the authority |

**Done when:** `review()` and `isHumanBacked()` have tests and README examples, and the issuer job passes a revoke on testnet.

### 7. Hardening (Atharva)

From Phase 8 of the plan. Check what `server/src/routes/rateLimits.ts` already covers before starting.

- Rate limits on every public route, and Mirror Node backoff on HTTP 429.
- An alert if no snapshot is published for 2 epochs, plus error monitoring on the verifier and scorer.
- Publish the scorer config version with each snapshot (the snapshot already carries `configVersion` and `inputsHash`; confirm it).
- Separate the admin, verifier and issuer keys. On testnet the operator holds all three.
- **Done when:** each item is checked off in Phase 8 of the plan.

### 8. Demo (both)

- Swapnil: run the site at phone width (T8.2) and fix what breaks; write the demo script from Phase 8 of the plan; record the video.
- Atharva: set the scorer epoch to 1 minute, pre-fund every account, and run the full script twice on fresh accounts (T8.1). T8.3 already passed.
- **Done when:** T8.1 and T8.2 pass twice in a row, each run under 5 minutes with no manual fixes, and the video is recorded.

## Decisions to make before step 8

Taken from the plan's open questions; each changes what the demo shows.

- Who confirms misconduct: keep the built 2-creator rule, or move to an arbiter or our own Validation Registry?
- Penalty sizes (built: fraud 20, failed settlement 10) and half-lives (reviews 90 days, penalties 180 days).
- Orb only (built), or also device-level World ID at a lower tier?
- Agent files as `data:` URIs (built), or IPFS or HCS-1?
- Scorer epoch length after the demo: hourly or daily?
- Can a creator move their record to a new wallet with a fresh World ID proof?

## Doc cleanup (anyone, any time)

- Fold the runbook's "Where this differs from the plan" list into `02-implementation-plan.md`.
- Re-check the status lines in `docs/03-features.md` against what is built.
- Add the step 3 to 5 results to the runbook's results table as they come in.

## Out of scope for the testnet MVP

Mainnet needs an ERC-8004 deployment on Hedera mainnet, a production World ID app, 2-of-3 verifiers and fee re-pricing. See "Before mainnet" in Phase 8 of the plan.

## Rough sizing

| Step | Effort | Depends on |
| --- | --- | --- |
| 1 World ID app | Under an hour, if the Developer Portal cooperates | — |
| 2 Review | Half a day | — |
| 3 Phase 2 runs | Half a day | 1 |
| 4 Phase 3 runs | Half a day | 3 |
| 5 Phase 4 and 5 gaps | Half a day | 3, 4 |
| 6 Missing features | One to two days | — (can start now) |
| 7 Hardening | One day | — |
| 8 Demo | One day, plus fixes found | 3 to 7 |

These are estimates, not measurements. The risk is in steps 3 and 4: this is the first time the signing flows meet a real World ID app, so expect fixes.
