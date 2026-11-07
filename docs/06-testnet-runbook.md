# Reputed — Testnet Runbook

The ordered steps from a funded operator to a live server, and which [plan](02-implementation-plan.md) tests each step unlocks.

**Status:** Phases 1, 3, 4 and 5 ran on testnet on 2026-11-06, with real transactions. See [Testnet results](#testnet-results). Phase 2 has not run, because it needs the World ID app. Phases 3 to 5 used test-only creators registered directly with the verifier key, so they prove the chain, server and scorer, not World ID.

Needs Foundry, Node 26, pnpm 9, `jq` and `python3`. Run `pnpm install` once at the repo root.

## Steps

Copy `.env.example` to `.env` if you have no `.env` yet. Scripts never edit `.env`: you paste their output in.

### 1. Fund the operator

The operator needs an ECDSA account. `OPERATOR_KEY` must be its raw 32-byte key, and `OPERATOR_ID` its `0.0.x` ID.

Send it at least 110 HBAR from the [Hedera Portal faucet](https://portal.hedera.com). The real run cost 72 HBAR with `FUND_HBAR=5`: 20.2 for the token, 2.5 to deploy, about 46 to the test accounts, and about 3 for the rollback check and Phase 1 tests.

### 2. Set the verifier key

Set `VERIFIER_KEY` to the same value as `OPERATOR_KEY`. The server requires it, deploy gives that key the verifier role, and step 3 does not fund any other key. Do this before deploying: changing it later means `grantRole` from the admin.

### 3. Fund the test accounts

```bash
cd contracts
FUND_HBAR=5 script/fund-accounts.sh
```

Tops up every test account, 10 HBAR by default, and is safe to re-run. The relay sometimes refuses a send: just run it again. It reads the `*_ADDRESS` values in `.env`.

### 4. Deploy and create the credential token

```bash
script/deploy.sh
```

Deploys CreatorRegistry, calls `initCredentialToken()` with 20 HBAR, and prints two lines. Paste `CREATOR_REGISTRY` and `CREDENTIAL_TOKEN_ID` into `.env`.

If it fails after deploying, set `CREATOR_REGISTRY` and run it again: it skips the deploy. If init reverts with code 9, raise `INIT_HBAR`, because the fee moves with the exchange rate.

### 5. Prove rollback before relying on revoke

```bash
script/check-rollback.sh
```

This is T1.9b and costs about 5 HBAR. It must exit 0. If it fails, a failed revoke can leave a credential transferable, so stop and fix that first.

### 6. Verify the source

```bash
node script/verify-source.mjs "$CREATOR_REGISTRY" <deploy transaction hash>
```

Export `CREATOR_REGISTRY` first. This uses Sourcify's v2 API because forge 0.2.0 cannot reach the current verifier.

### 7. Create the topics

```bash
cd ../server
pnpm exec tsx --env-file=../.env scripts/create-topics.ts
```

Prints `REVIEWS_TOPIC_ID` and `SCORES_TOPIC_ID`. Paste both into `.env`. A topic already set in the environment is left alone. Both topics have the operator as submit key and no admin key, so published records cannot be changed.

### 8. Set up World ID

In the Developer Portal, create the staging app and the action `agent-creator-v1`, limited to one verification per person. Then fill in `.env`:

| Variable | Value |
| --- | --- |
| `WORLD_RP_ID` | The app's `rp_...` ID. The plan's `app_id` is not what the server uses |
| `RP_SIGNING_KEY` | Shown once. A server secret, never `NEXT_PUBLIC_` |
| `WORLD_ENVIRONMENT` | `staging` |
| `WORLD_PROTOCOL_VERSION` | What the Simulator emits, `3.0` or `4.0`. A wrong guess rejects every proof with a message naming the expected version |

### 9. Set server options

Only if needed:

| Variable | When |
| --- | --- |
| `CORS_ORIGINS` | The web app is not on `http://localhost:3000` |
| `TRUST_PROXY=127.0.0.1` | Behind a local ngrok agent. `true` is refused at boot |
| `SCORER_EPOCH_SECONDS=60` | Short epochs for a demo. Set it before the first start, because a change starts a new series on the scores topic |

### 10. Start the server

```bash
pnpm start
```

Run from `server/`. If anything required is missing, it exits 1 and lists the variable names, never their values.

The first tick indexes the chain, then publishes the scorer config and the latest complete epoch. Check that it is live:

```bash
curl -s localhost:4000/api/agents
curl -s -X POST localhost:4000/api/rp-signature -H 'content-type: application/json' -d '{}'
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/<SCORES_TOPIC_ID>/messages?limit=2"
```

The log should show `scorer: published epoch N as message M`. `scorer: tick failed, will retry: <reason>` names what to fix, for example a Hedera status such as `INSUFFICIENT_PAYER_BALANCE`.

## What each step unlocks

| After step | Tests you can run | How |
| --- | --- | --- |
| 1, 3 | T0.1 | Mirror Node. T0.2–T0.4 are read-only and need no funds |
| 4 | T1.1, T1.2, T1.3, T1.4, T1.6–T1.9 | `cast send` with the limits in [contracts/README.md](../contracts/README.md#gas-limits), HashPack or SDK for T1.7 |
| 4 | T1.5 | Turn the wallet's auto-association off first. See [Running T1.5](../contracts/README.md#running-t15-on-testnet) |
| 5 | T1.9b | The script is the test |
| 6 | Phase 1 exit | HashScan shows the source |
| 7 | T4.9 | SDK from wallet U |
| 8 | T0.5 | Developer Portal |
| 10 | T2.1–T2.8 | Needs a real IDKit client, which is the Verify screen in `web/`. The screen is built but unrun, and it needs the World ID app from step 8 |
| 10 | T3.1–T3.9 | After T2.8, which registers the creators. `cast send` with `POST /api/agent-file`, or the Onboard wizard |
| 10 | T4.1–T4.8 | After Phase 3. Each review file must be signed by its client |
| 10 | T5.1–T5.9, T8.3 | After Phase 4. T5.8 by deleting `server/cache/scorer.sqlite*` and restarting: the log reports whether the rebuilt `inputsHash` matches the topic |

**Run T1.4 on a throwaway address, not Creator A.** `registerCreator` claims a wallet permanently, and there is no way to undo it, so T1.4 as written would make T2.1 return `WALLET_TAKEN`. For the same reason, calling `registerCreator` directly to get ahead of the Verify flow leaves that wallet unable to pass Phase 2, and it is not a verified human.

Check these on the first funded run, because nothing has observed them:

- Real gas use against the limits in the contracts README.
- `total_supply` on the Mirror Node is unchanged after a failed `issueCredential`.
- Contract key authority: T1.2 and T1.6 are the first real test, because simulation checks no signatures.
- `TRUST_PROXY` through a real ngrok hop, with a spoofed `X-Forwarded-For`.

## Where this differs from the plan

The implementation plan has not been updated for these:

- **Gas:** `linkAgent`, `syncAgentWallet` and `issueCredential` need a 1,500,000 limit, not 1,000,000, and `web/` must set it explicitly.
- **T3.6:** a wallet with free auto-association slots receives the credential, so the revert only applies to wallets with none.
- **World ID 4.0:** the web flow is `POST /api/rp-signature`, then the wallet signs `walletBindingMessage`, then IDKit, then `POST /api/verify`. T2.7 now means a wrong `WORLD_RP_ID`.
- **Signatures:** `POST /api/verify` and `POST /api/review-file` require a wallet signature. Build the signed bytes with `walletBindingMessage` and `serializeReviewFile` from `@reputed/shared`.
- **Sessions:** the web app signs `sessionMessage` once per wallet, trades it at `POST /api/session` for a 7-day token and keeps it in `localStorage`, so a reload recognizes the wallet without another signature or World ID scan. `GET /api/session` checks a token. A token proves control of the wallet; it does not authorize transactions, which still need the connected wallet.
- **Wallet rotation:** a wallet set after linking is backed only after the creator calls `syncAgentWallet`.

## Known gaps

- **Stale credentials:** the issuer job that revokes a credential after a sale, rotation or compromise report is not built. Until it is, the old wallet keeps a frozen NFT, so `humanBacked` from the API is the authority, never the NFT.
- **Separate keys:** on testnet the operator holds all three roles. Split them before anything beyond testnet.

## Testnet results

Run on 2026-11-06 with `server/scripts/testnet-phase3.ts`, `testnet-phase4.ts` and `testnet-phase5.ts`, against the real server with a 60-second epoch. The creators were `TEST_CREATOR_1` to `3`, whose nullifiers are labelled `reputed-test-only`. They never went through World ID.

| Test | Result |
| --- | --- |
| T4.1–T4.9 | Passed. HCS bytes hash to `feedbackHash`, and a direct post from wallet U was refused |
| T5.1 | Passed. Agent 159 scored 90, Tier 1, and snapshots reached topic 0.0.11339621 |
| T5.2, T5.3 | Passed. Excluded as `not-human-backed` and `payment-not-found`, and the score stayed at 90 |
| T5.4 | Passed. Two creators reported fraud: agent and creator fell from 90 to 22.5, P is 20, and the other creators stayed at 100 |
| T5.5 | Passed. Agent 160 has no reviews and shows 22.5 and New, not 100 |
| T5.8 | Passed. A rebuild from an empty database logged `inputsHash matches the topic` |
| T8.3 | Passed. After a stop of more than one epoch, the scorer caught up and published the missed epochs |
| T5.6, T5.7, T5.9 | Not run on testnet. The unit tests cover them. T5.6 needs two more creators because of the reporter cooldown |

The agent score of 22.5 follows from one vote per creator: creator 2 averages 45 across their reviews, creator 3 gives 0, and the mean of those is 22.5. Creator score is the lower of that and 100 − P, which is 80.

To boot the server before the World ID app exists, set `WORLD_RP_ID`, `RP_SIGNING_KEY`, `WORLD_ENVIRONMENT` and `WORLD_PROTOCOL_VERSION` to throwaway values for that process only. `POST /api/verify` will not work until real values are set.
