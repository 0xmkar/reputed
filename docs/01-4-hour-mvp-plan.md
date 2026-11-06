# Human-Backed Agent Reputation — 4-Hour MVP Plan

Nov 6, 2026

In 4 hours we ship one working path on Hedera testnet: a World ID–verified creator onboards an agent, another creator's agent reviews it, and a misconduct report visibly lowers both the agent's score and its creator's score.

## What ships, and what is cut

We build only what the demo path needs, and reuse the ERC-8004 registries already on testnet. We deploy one small contract.

| Area | Ships in the MVP | Cut or simplified for now |
| --- | --- | --- |
| Creator identity | World ID (staging app + Simulator) → verifier API → `registerCreator` | Device-level tier, wallet migration |
| Contract | CreatorRegistry with `registerCreator`, `linkAgent`, `creatorOf`, `agentsOf`, `isHumanBacked` | `reportCompromise`; credential minting inside the contract |
| Agent registration | `register` on the deployed ERC-8004 Identity Registry. The agent file is a base64 `data:` URI, which the spec allows, so no IPFS is needed. | Separate agent wallet, HCS-14/HCS-11, editing the agent file |
| Credential NFT | One HTS collection made once by a backend script. After `linkAgent`, the backend mints the Human-backed credential, transfers it and freezes it. | Contract-controlled minting, revocation, signed VC file, milestone credentials |
| Token association | Setup gives test accounts unlimited auto-association, so the UI has no association step | The association helper |
| Reviews | `giveFeedback` on the deployed Reputation Registry; the comment is posted to an HCS reviews topic | Payment-proof check, revoke, agent responses, x402 |
| Scoring | Computed on request from on-chain events: human-backed filter, agent average, misconduct penalty, creator score = lower of (agent average) and (100 − penalties), new agents inherit the creator score | Hourly snapshots (replaced by one "Publish snapshot" button), decay, compromise rule. A misconduct report counts after 1 report from another creator, not 2. |
| Web app | Verify; Onboard (2 steps); Agent page with the review form; a home page listing all agents | Creator profile, explorer filters, mobile polish |
| SDK / API / MCP | — | All of it |

The full scope is in the [Phased Implementation Plan](02-implementation-plan.md); anything cut here waits for those phases.

## Hour-by-hour plan

Five time blocks, each ending at a checkpoint the whole team checks together in 5 minutes. If a checkpoint is missed, go to the cut list at the end.

| Block | Time | Work | Checkpoint |
| --- | --- | --- | --- |
| Setup | 0:00–0:20 | Accounts, repo, env, World ID app | — |
| Core build | 0:20–1:20 | Contract, verify API, app shell | **1:20** Contract live |
| Flows | 1:20–2:20 | Verify + onboard work end to end | **2:20** Agent onboarded |
| Trust | 2:20–3:20 | Reviews, scores, agent page | **3:20** Score drop visible (the core demo moment) |
| Ship | 3:20–4:00 | Test, code freeze at 3:40, rehearse, record | **4:00** Demo ready |

**Splitting the work**

- **3 people:** one per track (A Contracts, B Backend, C Frontend). Times are the same in each track.
- **2 people:** one person takes Tracks A and B (the contract is small); the other takes C.
- **Solo:** contract (to 1:00) → verify API → Verify screen → Onboard → scoring API → Agent page. Cut items 1–4 of the cut list from the start.

**Hand-offs between tracks**

- 1:20: Track A gives B and C the CreatorRegistry address and ABI.
- 2:00: Track B gives C the response shape of `GET /api/agents/:id`.
- 2:40: Track A gives B and C the seeded agents (B1, C1) for testing.

## Track A — Contracts

One small contract, live on testnet by 1:20. After that, this track seeds the demo and backs up the others.

- [ ] **0:00–0:20 Setup (everyone together).**
  - Create testnet accounts: Operator, Creators A, B and C, and agent wallets A1, A2, B1, C1.
  - Set every test account to unlimited automatic token association, so credentials arrive without an association step.
  - Create a Hardhat project with the `hederaTestnet` network (chain 296, Hashio relay).
  - Start a shared `.env` file.
- [ ] **0:20–1:00 Write CreatorRegistry.**
  - Storage: nullifier → creator; wallet → is-creator; agentId → creator; creator → list of agent IDs.
  - `registerCreator`: verifier only; nullifier and wallet must be unused.
  - `linkAgent`: the caller is a creator and `ownerOf(agentId)` in the Identity Registry, and the agent is not linked yet.
  - Views: `creatorOf`, `agentsOf`, `isHumanBacked`.
  - Events: `CreatorRegistered`, `AgentLinked`.
  - Unit tests on the local network, with a stand-in Identity Registry.
- [ ] **1:00–1:20 Deploy to testnet.** Pass the Identity Registry address (`0x8004A818…BD9e`), set the verifier to Track B's key, and put the address in `.env`. **Checkpoint 1:20: contract live.**
- [ ] **1:20–2:00 Seed scripts.** Scripts that register an agent, link it, and give feedback. Use them to set up Creator B with agent B1 and Creator C with agent C1. This proves the on-chain flow before the UI exists.
- [ ] **2:00–2:40 Help Track B.** Give it the exact event signatures and Mirror Node log endpoints:
  - Identity Registry: `Transfer`
  - Reputation Registry: `NewFeedback`
  - CreatorRegistry: `CreatorRegistered`, `AgentLinked`
- [ ] **2:40–3:20 Seed the demo state.** B1 and C1 are linked and hold credentials. B1's 90 review of A1 and C1's fraud report are ready to run on cue.
- [ ] **3:20–3:40 Run tests M4, M5, M7 and M11** (see MVP manual tests).

## Track B — Backend

Six endpoints, one HTS collection and two HCS topics. Scores are computed on request, so no background job is needed.

**MVP scoring rules** (simpler than the main plan; no weights or decay):

- A review counts only if the reviewer is human-backed and comes from a different creator.
- Agent score = the plain average of counted review values. An agent with none shows its creator's score, labelled "New".
- Each misconduct review from another creator adds a 20-point penalty to the agent's creator.
- Creator score = the lower of (the average of their reviewed agents) and (100 minus penalties). A creator with no reviewed agents scores 100 minus penalties.
- Tiers: Tier 1 at 90 or above, Tier 2 at 75 or above, Tier 3 below.

**Tasks**

- [ ] **0:00–0:20 Setup.** In the World ID Developer Portal, create a staging app and the action `agent-creator-v1`, limited to one verification per person. Start the Node/TypeScript server.
- [ ] **0:20–1:10 `POST /api/verify`.**
  - Receives the proof fields and the wallet, and checks the proof with World ID's cloud verify API (signal = wallet).
  - Calls `registerCreator` with the verifier key and returns the transaction ID.
  - Errors: `ALREADY_REGISTERED`, `WALLET_TAKEN`, `INVALID_PROOF`.
  - Until the contract is live at 1:20, test the World ID half on its own.
- [ ] **1:10–1:40 Credential.**
  - A one-time script creates the HTS NFT collection "Human-backed Agent". The operator is treasury and holds the supply and freeze keys.
  - `POST /api/credential {agentId}` checks `creatorOf(agentId)` on-chain, then mints, transfers to the agent wallet, and freezes that wallet for the token.
- [ ] **1:40–2:00 HCS.** Create the reviews topic and the scores topic, both with a submit key the backend holds. `POST /api/review-file` posts the review JSON to the reviews topic and returns `hcs://<topic>/<sequence>` plus its keccak-256 hash.
- [ ] **2:00–3:00 `GET /api/agents` and `GET /api/agents/:id`.**
  - Read the events from Mirror Node logs, then apply the scoring rules above.
  - Return everything the agent page needs in one response: profile, score, tier, creator, creator score, credential serial, and reviews with a counted/excluded flag and reason.
- [ ] **3:00–3:20 `POST /api/snapshot`.** Posts the current scores as JSON to the scores topic and returns the HashScan link.
- [ ] **3:20–3:40 Run tests M1, M2, M9, M10, M12 and M14.**

## Track C — Frontend

Three screens plus a home list. Build the five shared components first (score ring, tier badge, Human-backed badge, address chip, transaction button); the [UI Elements](04-ui-elements.md) doc describes each one.

- [ ] **0:00–0:20 Setup.** Create a Next.js app with wagmi + viem and a custom Hedera testnet chain (ID 296, Hashio RPC). Deploy a preview right away, so a public URL exists from the start.
- [ ] **0:20–1:00 Layout.** Header with the wallet button, a wrong-network banner with a Switch button, and a home page listing agents (placeholder data until 2:00). Build the five shared components.
- [ ] **1:00–1:40 Verify screen.** World ID widget (staging app, action `agent-creator-v1`, signal = connected wallet) → `POST /api/verify` → poll the Mirror Node until the creator is registered → show the "Verified creator" badge.
- [ ] **1:40–2:30 Onboard, in 2 steps.**
  - Step 1: a form with name, description and one endpoint. The app builds the ERC-8004 JSON, encodes it as a base64 `data:` URI, and calls `register`.
  - Step 2: `linkAgent(agentId)`, then `POST /api/credential`. The success screen shows the agent ID and HashScan links.
  - Unverified wallets are sent to Verify. **Checkpoint 2:20: agent onboarded.**
- [ ] **2:30–3:20 Agent page.**
  - Score ring with tier (or "New"), Human-backed badge, creator card with creator score, credential card with HashScan link.
  - Reviews list with Counted / Excluded labels.
  - Review form: value 0–100, Quality / Misconduct, comment → `POST /api/review-file` → `giveFeedback`. The button is disabled on your own agent.
  - A "Publish snapshot" button.
  - **Checkpoint 3:20: score drop visible.**
- [ ] **3:20–3:40 Run tests M3, M6, M8, M13 and M15.** Fix blockers only.
- [ ] **3:40 Code freeze.**

## MVP manual tests

Run all 15 between 3:20 and 3:40, split by track. Use fresh World ID Simulator identities and HashScan to confirm.

- [ ] **M1** A new Simulator identity verifies with Creator A's wallet. The "Verified creator" badge shows, and `CreatorRegistered` appears on the Mirror Node.
- [ ] **M2** The same identity tries again with another wallet. It is blocked: "This World ID already has a creator wallet."
- [ ] **M3** An unverified wallet opens Onboard and is sent to Verify.
- [ ] **M4** Onboard A1. The agent ID is shown, `ownerOf` = Creator A, and the `tokenURI` decodes to the agent JSON.
- [ ] **M5** After linking, `creatorOf(A1)` = Creator A. The credential NFT is in A1's wallet on HashScan, and the wallet is frozen for the token.
- [ ] **M6** Try to transfer the credential out of A1's wallet. It fails with `ACCOUNT_FROZEN_FOR_TOKEN`.
- [ ] **M7** `linkAgent` on another creator's agent reverts.
- [ ] **M8** A1, with no reviews, shows "New" and its creator's score (100 for a clean creator).
- [ ] **M9** B1 reviews A1 with 90, Quality. Within about 10 seconds, A1 shows 90, Tier 1, and the review is marked Counted.
- [ ] **M10** An unverified wallet reviews A1 with 0. The review is recorded but marked "Excluded: not human-backed", and the score stays 90.
- [ ] **M11** Creator A sees the review button disabled on A1. A direct contract call from Creator A reverts.
- [ ] **M12** C1 reports fraud on A1 (value 0). A1 drops to 45, Creator A drops to 45, and Creators B and C are unchanged.
- [ ] **M13** Creator A onboards A2. A2 starts at 45, not 100.
- [ ] **M14** Publish snapshot. The message is visible on the scores topic in HashScan.
- [ ] **M15** On the wrong network, the banner shows and the Switch button works.

## 3-minute demo script

The demo ends on one line: reputation follows the human, not the wallet. Before starting, have Creators B and C verified, with agents B1 and C1 seeded. Keep a fresh Simulator identity ready for Creator A.

1. **0:00 — The problem.** "Agents have IDs on Hedera, but nothing ties their reputation to a real person. A bad actor just makes a new agent."
2. **0:15 — Verify.** Creator A verifies with World ID. The "Verified creator" badge appears.
3. **0:40 — Onboard.** Onboard "TradeBot A1". The agent page shows the Human-backed badge, the frozen credential on HashScan, and "New · 100".
4. **1:10 — Good review.** B1 reviews A1 with 90. A1 shows 90, Tier 1.
5. **1:30 — Misconduct.** C1 reports fraud. A1 drops to 45, and the creator card shows Creator A at 45.
6. **2:00 — No escape.** Creator A tries to start over with a new wallet. World ID blocks a second creator.
7. **2:20 — The payoff.** Creator A onboards A2, which starts at 45, not 100.
8. **2:40 — Proof on-chain.** Publish a snapshot and open it on HashScan. Close by naming the stack: ERC-8004 registries, World ID, HTS credential, HCS scores.

At 3:50, record a screen capture of a full run as a backup.

## If you fall behind: what to cut, in order

Never cut the agent-to-creator link or the score drop on both. That is the whole idea.

1. **Publish snapshot.** The scores still show on the page.
2. **Review comments on HCS.** Send `giveFeedback` with an empty `feedbackURI`.
3. **Freezing the credential.** Keep mint and transfer; mention non-transferability as next.
4. **Home page list.** Link straight to agent pages.
5. **The Onboard UI** (if not done by 2:20). Onboard with Track A's seed script on stage and show the agent page.
6. **Live World ID** (if not working by 2:00). Switch the verifier to a clearly labelled "Demo mode" that registers a test nullifier, and say so during the demo.
