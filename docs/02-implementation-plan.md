# Human-Backed Agent Reputation on Hedera — Phased Implementation Plan

Nov 6, 2026

## Overview

We are building a human-backed reputation layer for AI agents on Hedera. Every agent's creator is a unique World ID–verified human. Agent reviews live in the ERC-8004 Reputation Registry. Proven misconduct by an agent lowers its creator's score, and a creator cannot escape that by starting over with a new wallet.

The plan has nine phases (0–8). Each ends with manual tests. A phase is done only when every test in it passes on Hedera testnet.

| Component | Status | Built in | Where it lives |
| --- | --- | --- | --- |
| ERC-8004 Identity Registry | Use as-is | — | Testnet `0x8004A818BFB912233c491871b3d84c89A494BD9e` (0.0.7919997) |
| ERC-8004 Reputation Registry | Use as-is | — | Testnet `0x8004B663056A597Dffe9eCcC1965A193B7388713` (0.0.7919998) |
| CreatorRegistry contract | Build | Phase 1 | Hedera EVM |
| Credential NFT collection (HTS) | Build | Phase 1 | HTS, all keys held by CreatorRegistry |
| World ID verifier server | Build | Phase 2 | Backend |
| Reviews topic and scores topic (HCS) | Build | Phases 4–5 | HCS |
| Scorer service | Build | Phase 5 | Backend |
| Web app | Build | Phase 6 | Frontend |
| Agent SDK, REST API and MCP tools | Build | Phase 7 | npm package + backend |

Conventions used in this plan:

- **Network:** Hedera testnet, EVM chain ID 296, JSON-RPC relay `https://testnet.hashio.io/api`, Mirror Node `https://testnet.mirrornode.hedera.com`.
- **Rule of thumb:** reviews go in the registry; credentials go in the wallet.
- **Test IDs:** `T<phase>.<n>`, so failures can be reported by ID.
- **Test accounts:** Creator A, Creator B, agents A1, A2 and B1, and an unverified wallet U. All are created in Phase 0.

**Architecture: CreatorRegistry ties each agent to one verified human**

```mermaid
flowchart LR
  V["World ID verifier<br/>checks the proof, calls registerCreator"] --> CR["CreatorRegistry<br/>creators, agent links, compromise reports"]
  CR --> NFT["HTS credential NFTs<br/>minted and frozen via 0x167"]
  CR --> ID["ERC-8004 identity<br/>one NFT per agent, already on testnet"]
  W["Web app and API<br/>creators sign register, linkAgent, reviews"] --> V
  W --> CR
  W --> ID
  W --> REP["ERC-8004 reputation<br/>reviews per agent, already on testnet"]
  REP --> HCS["HCS topics<br/>review files and score snapshots"]
  REP --> S["Scorer service<br/>filters reviews, scores agents and creators"]
  S --> HCS
```

Both ERC-8004 registries are already live on testnet. Everything else in the picture is built in Phases 1–7.

## Phase 0 — Environment and accounts

Goal: every team member can read and write the ERC-8004 registries on Hedera testnet from their own machine.

**Tasks**

1. Create testnet accounts in the Hedera Developer Portal and fund them from the faucet. Use ECDSA (secp256k1) keys so the same accounts work in MetaMask:
   - Operator (deployer, also holds the verifier role on testnet)
   - Creator A, Creator B
   - Agent A1, Agent A2, Agent B1
   - Unverified wallet U
2. Set up the repo:
   - `/contracts`: Hardhat or Foundry
   - `/server`: verifier and scorer, Node + TypeScript
   - `/web`: Next.js
   - `/sdk`
3. Add a `hederaTestnet` network to the contracts config: RPC `https://testnet.hashio.io/api`, chain ID 296, accounts from `.env`.
4. Create `.env.example` with:
   - `OPERATOR_ID`, `OPERATOR_KEY`
   - `IDENTITY_REGISTRY=0x8004A818BFB912233c491871b3d84c89A494BD9e`
   - `REPUTATION_REGISTRY=0x8004B663056A597Dffe9eCcC1965A193B7388713`
   - `MIRROR_NODE=https://testnet.mirrornode.hedera.com`
   - `WORLD_APP_ID`, `WORLD_ACTION=agent-creator-v1`
5. Copy the ABIs for `IdentityRegistryUpgradeable` and `ReputationRegistryUpgradeable` from the erc-8004-contracts repo into `/contracts/abi`.
6. In the World ID Developer Portal, create a staging app and an action named `agent-creator-v1`, limited to one verification per person.
7. Keep two money facts in a shared note:
   - The JSON-RPC relay counts HBAR with 18 decimals; contracts count it with 8.
   - One transaction can use at most 15,000,000 gas.

**Manual tests**

- [ ] T0.1 For each account, `GET /api/v1/accounts/<id>` on the Mirror Node shows a balance above 0 and an `evm_address`.
- [ ] T0.2 `ethers.provider.getBlockNumber()` on `hederaTestnet` returns a number.
- [ ] T0.3 Calling `name()` on the Identity Registry returns a string without reverting.
- [ ] T0.4 Calling `getIdentityRegistry()` on the Reputation Registry returns `0x8004A818…BD9e`.
- [ ] T0.5 The `agent-creator-v1` action appears under the staging app in the World ID Developer Portal.

**Exit:** T0.1–T0.5 pass for every team member.

## Phase 1 — CreatorRegistry contract and credential NFTs

Goal: one contract records creators and agent links, and fully controls a non-transferable HTS credential collection.

**Contract functions**

| Function | Who can call | What it does |
| --- | --- | --- |
| `initCredentialToken()` | Admin, once | Creates the HTS NFT collection through the `0x167` system contract. The contract is treasury plus supply, freeze and wipe key. Send about 20 HBAR with the call to cover the roughly $1 creation fee. |
| `registerCreator(bytes32 nullifierHash, address wallet)` | Verifier role | Reverts if the nullifier or wallet is already registered. Stores the creator and emits `CreatorRegistered`. |
| `linkAgent(uint256 agentId)` | A registered creator who is `ownerOf(agentId)` in the Identity Registry | Stores agentId → creator permanently, once. Emits `AgentLinked`. Issues the Human-backed credential to `getAgentWallet(agentId)`. |
| `reportCompromise(uint256 agentId)` | That agent's creator | Records the time. The scorer stops passing later penalties up to the creator. Emits `AgentCompromised`. |
| `issueCredential(address to, bytes metadata)` | Issuer role | Mints a serial with metadata of 100 bytes or less, unfreezes the holder, transfers the serial, then refreezes. |
| `revokeCredential(address holder, int64 serial)` | Issuer role | Unfreezes the holder, wipes the serial, refreezes. Emits `CredentialRevoked`. |
| `creatorOf(agentId)`, `agentsOf(creator)`, `isHumanBacked(address)` | Anyone | Read-only views. `isHumanBacked` is true for creator wallets and for linked agents' wallets. |

**Tasks**

1. Write `CreatorRegistry.sol` with role-based access: admin, verifier, issuer.
2. Check every `0x167` response code, and revert unless it is 22 (SUCCESS).
3. Credential metadata is a short URI only, such as `ipfs://<cid>` or an HCS file reference, because HTS caps NFT metadata at 100 bytes.
4. Deploy to testnet, then call `initCredentialToken()`.
5. Gas estimates for `0x167` calls are unreliable. Start minting calls at 1,000,000 gas, then lower the limit once the Mirror Node shows real gas used.
6. Test locally first: unit tests for every revert path. HTS calls must be tested on testnet or a Hedera local node.

**Manual tests**

- [ ] T1.1 After deploy, the contract appears on HashScan and `identityRegistry()` returns `0x8004A818…BD9e`.
- [ ] T1.2 After `initCredentialToken()`, Mirror Node `GET /api/v1/tokens/<id>` shows type `NON_FUNGIBLE_UNIQUE`, treasury = the contract, and the supply, freeze and wipe keys = the contract.
- [ ] T1.3 `registerCreator` from wallet U (not the verifier) reverts.
- [ ] T1.4 `registerCreator(N1, Creator A)` from the verifier emits `CreatorRegistered`. Repeating with `N1` and Creator B reverts.
- [ ] T1.5 `issueCredential` to an account not associated with the token fails with `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT`.
- [ ] T1.6 After that account associates, `issueCredential` succeeds. `GET /api/v1/accounts/<id>/nfts` lists the serial, and HashScan shows the account frozen for the token.
- [ ] T1.7 Transferring that NFT from the holder (HashPack or SDK) fails with `ACCOUNT_FROZEN_FOR_TOKEN`.
- [ ] T1.8 Issuing a second credential to the same holder succeeds (unfreeze, transfer, refreeze).
- [ ] T1.9 `revokeCredential` removes the serial from the holder's NFT list.

**Exit:** T1.1–T1.9 pass, the contract address and token ID are in `.env`, and the contract source is verified on HashScan.

## Phase 2 — World ID verifier and creator registration

Goal: one verified human becomes exactly one creator record on-chain, bound to the wallet they chose.

**Flow**

1. The web app shows the World ID widget (IDKit) with `app_id`, action `agent-creator-v1`, and the creator's wallet address as the signal. The signal binds the proof to that wallet, so a proof cannot be reused for another wallet.
2. The widget returns the proof, Merkle root, nullifier hash and verification level.
3. The app sends `POST /api/verify` with the proof fields and the wallet.
4. The server verifies the proof with World's verify API. Use the endpoint version in World's current reference docs; it has changed between versions. Accept only Orb-level verification (open question: allow device level as a lower tier).
5. The server checks the contract: if the nullifier is already registered, it returns 409.
6. The server calls `registerCreator(nullifierHash, wallet)` with the verifier key and returns the transaction ID.
7. The app polls the Mirror Node until `CreatorRegistered` appears. This usually takes a few seconds.

**Tasks**

1. Build `POST /api/verify`. Validate input, call World's API, check the contract, submit the transaction, return the transaction ID.
2. Keep the verifier key only in server environment variables. It never reaches the browser.
3. Store no personal data. Log the transaction ID and the nullifier hash only.
4. Rate-limit by IP and by wallet.
5. Return errors in a fixed shape: `{code, message}` with codes `INVALID_PROOF`, `ALREADY_REGISTERED`, `WALLET_TAKEN`, `WORLD_UNAVAILABLE`, `CHAIN_ERROR`.

**Manual tests** (staging app, World ID Simulator)

- [ ] T2.1 Verify with simulator identity 1 for Creator A. The API returns 200 and a transaction ID, and `CreatorRegistered(N1, CreatorA)` appears on the Mirror Node.
- [ ] T2.2 Verify again with simulator identity 1 for Creator B. The API returns 409 `ALREADY_REGISTERED`, and no new event appears.
- [ ] T2.3 Generate a proof for Creator B, then change the wallet in the request body to wallet U. The API returns 400 `INVALID_PROOF`.
- [ ] T2.4 Replay T2.1's exact request. The API returns 409, and no event appears.
- [ ] T2.5 Verify simulator identity 2 for Creator A's wallet. The API returns 409 `WALLET_TAKEN`.
- [ ] T2.6 Verify with a device-level credential. The API rejects it with a clear message (if Orb-only).
- [ ] T2.7 Set a wrong `app_id` on the server and verify. The API returns 502 `WORLD_UNAVAILABLE`, and no transaction is sent.
- [ ] T2.8 Verify simulator identity 2 for Creator B. It succeeds, so testing now has two creators.

**Exit:** T2.1–T2.8 pass. Creator A and Creator B are both registered.

## Phase 3 — Agent onboarding

Goal: a verified creator registers an agent in ERC-8004 and links it to their creator record, and the agent's wallet receives a Human-backed credential.

**Flow**

1. **Build the agent file.** Follow ERC-8004's registration format:
   - `type`, `name`, `description`, `image`
   - `services`: A2A and MCP endpoints
   - `x402Support`, `active`
   - `supportedTrust: ["reputation"]`
   - `registrations`, filled in at step 4
2. **Host the file.** Upload it to IPFS (pinned) or an HCS-1 file topic. Keep the URI and its keccak-256 hash.
3. **Register.** The creator wallet calls `register(agentURI)` on the Identity Registry. Read the new `agentId` from the ERC-721 `Transfer` event (minted from `0x0`).
4. **Record the registration.** Add `{agentId, agentRegistry: "eip155:296:0x8004A818BFB912233c491871b3d84c89A494BD9e"}` to `registrations`. Re-host the file and call `setAgentURI`. This step is optional for the MVP.
5. **Set the agent wallet** (only if the agent has its own account). Call `setAgentWallet(agentId, wallet, deadline, signature)` with an EIP-712 signature from the agent's wallet. Otherwise the agent wallet stays the creator's address.
6. **Associate.** The agent wallet associates with the credential token: either `associate()` on the token's EVM address (works from MetaMask) or `TokenAssociateTransaction`. This costs about $0.05.
7. **Link.** The creator calls `linkAgent(agentId)` on CreatorRegistry. The contract checks ownership, stores the link, and issues the Human-backed credential.
8. **Optional for the MVP.** Derive the agent's HCS-14 UAID (Module 9 Lab 5) and publish an HCS-11 profile so HCS-10 tools can find it.

Signatures the creator sees: `register`, then `linkAgent`, plus `associate` from the agent wallet when it is a separate account. Aim for no more than three popups.

**Manual tests**

- [ ] T3.1 `register` from Creator A succeeds. `ownerOf(agentId)` = Creator A, `tokenURI(agentId)` returns the URI, and the JSON opens and parses.
- [ ] T3.2 `linkAgent` from wallet U (not a creator) reverts.
- [ ] T3.3 Creator B calls `linkAgent` on Creator A's agent. It reverts because Creator B is not the owner.
- [ ] T3.4 `linkAgent` for A1 from Creator A emits `AgentLinked`. `creatorOf(A1)` = Creator A, A1's wallet holds a frozen credential serial, and `isHumanBacked(A1 wallet)` is true.
- [ ] T3.5 Calling `linkAgent` for A1 again reverts with "already linked".
- [ ] T3.6 `linkAgent` before the agent wallet is associated reverts with a clear reason. The app (Phase 6) prompts association.
- [ ] T3.7 `setAgentWallet` with a wrong signature reverts. With a valid one, `getAgentWallet(agentId)` returns the new wallet.
- [ ] T3.8 Transfer A1's identity NFT from Creator A to Creator B. `creatorOf(A1)` is still Creator A, and the agent wallet is cleared, as the spec requires.
- [ ] T3.9 Register and link A2 for Creator A, and B1 for Creator B. These are needed for Phases 4–5.

**Exit:** T3.1–T3.9 pass. Agents A1, A2 and B1 exist and are linked.

## Phase 4 — Reviews

Goal: a client that paid an agent can review it. The score sits in the Reputation Registry, and the full review, with proof of payment, sits on HCS.

**Review conventions**

| Field | Value |
| --- | --- |
| `value` / `valueDecimals` | 0–100 / 0 |
| `tag1` | `quality` or `misconduct` |
| `tag2` | Category, e.g. `accuracy`, `uptime`, `fraud`, `failed-settlement` |
| `endpoint` | The agent endpoint that was used |
| `feedbackURI` | `hcs://<reviewsTopicId>/<sequenceNumber>` (our own convention) |
| `feedbackHash` | keccak-256 of the review file |

The review file holds the ERC-8004 required fields: `agentRegistry`, `agentId`, `clientAddress`, `createdAt`, `value`, `valueDecimals`. It also holds the tags, a comment, and `proofOfPayment` (the Hedera transaction ID of the client's payment to the agent wallet). Keep it under 1,024 bytes so it fits in one HCS message.

**Tasks**

1. Create the reviews HCS topic. Set a submit key held by the backend so random accounts cannot spam it; the backend posts files on clients' behalf.
2. Build `POST /api/review-file`. It validates the file, posts it to HCS, and returns `feedbackURI` and `feedbackHash`.
3. The client wallet calls `giveFeedback(agentId, value, 0, tag1, tag2, endpoint, feedbackURI, feedbackHash)`.
4. Support `revokeFeedback(agentId, feedbackIndex)` for the reviewer, and `appendResponse(...)` for the agent's reply.
5. Proof of payment for the MVP: a plain HBAR or token transfer from the client to the agent wallet. Full x402 support via the official `@x402/hedera` packages comes later.
6. The registry already blocks owners and operators from reviewing their own agent. The human-backed filter runs in the scorer (Phase 5), not on-chain.

**Manual tests**

- [ ] T4.1 B1's wallet sends 1 HBAR to A1's wallet. Note the transaction ID.
- [ ] T4.2 B1 reviews A1 (value 90, `quality`) with that payment as proof. `NewFeedback` appears on the Mirror Node, the HCS message is readable, and its keccak-256 equals `feedbackHash`.
- [ ] T4.3 Creator A reviews their own agent A1. The registry reverts.
- [ ] T4.4 `readFeedback(A1, B1 wallet, index)` returns value 90 with the tags.
- [ ] T4.5 Wallet U reviews A1 (value 0) with no payment. The review lands on-chain; the scorer must ignore it (checked in T5.2).
- [ ] T4.6 B1 reviews A1 with a made-up payment ID. The review lands on-chain; the scorer must ignore it (checked in T5.3).
- [ ] T4.7 B1 revokes one review. `readAllFeedback` leaves it out by default.
- [ ] T4.8 A1's owner calls `appendResponse` on a review. `ResponseAppended` appears.
- [ ] T4.9 Post a review file to the topic directly from wallet U. It is rejected because of the submit key.

**Exit:** T4.1–T4.9 pass. The reviews topic ID is in `.env`.

## Phase 5 — Scorer service

Goal: every epoch, compute agent and creator scores from public data the same way every time, and publish them to HCS so anyone can recheck them. The numbers below are starting values to tune, not final.

**Inputs**

- Reputation Registry events (`NewFeedback`, `FeedbackRevoked`, `ResponseAppended`), from Mirror Node contract logs
- Review files on the reviews topic
- CreatorRegistry events (`CreatorRegistered`, `AgentLinked`, `AgentCompromised`)
- Payment transactions, looked up by ID on the Mirror Node

**Which reviews count.** A review counts only if all of these hold:

- It is not revoked.
- The file hash matches `feedbackHash`.
- The reviewer is human-backed (`isHumanBacked`).
- The payment exists, went from the reviewer to the agent wallet, and happened before the review.
- The reviewer's creator is not the agent's creator.

**Agent score.** A weighted average of counted reviews. Each review's weight w is the reviewer creator's score C divided by 100 (never below 0.2), multiplied by a 90-day half-life on the review's age in days.

$$A = \frac{\sum_i w_i v_i}{\sum_i w_i}, \qquad w_i = \max\left(0.2, \frac{C_{\text{reviewer}}}{100}\right) \cdot 0.5^{\text{age}_i / 90}$$

An agent with no counted reviews starts at its creator's current score and is shown as "New". Tiers reuse the HCS-25 lab: Tier 1 at 90 or above, Tier 2 at 75 or above, Tier 3 below.

**Misconduct.** A `misconduct` review becomes a confirmed penalty when 2 or more counted reviews from different creators report it within 30 days. Proposed penalties: `fraud` 20 points, `failed-settlement` 10. Who confirms misconduct is an open question.

**Creator score.** The average of the creator's agent scores, weighted by review count, but never above 100 minus P. P is the sum of the creator's penalties, each decayed with a 180-day half-life. The cap is what stops dilution: extra good agents raise the average, but cannot lift the score past the penalties.

$$C = \min\left(\overline{A}_{\text{agents}},\; 100 - P\right), \qquad P = \sum_j p_j \cdot 0.5^{\text{age}_j / 180}$$

**Compromise rule.** Penalties dated after an agent's `reportCompromise` still lower that agent's score, but are left out of the creator's P.

**Tasks**

1. Build an indexer that reads events from the Mirror Node with paging, backs off on HTTP 429, and saves the last processed timestamp.
2. Implement the filter and formulas as pure functions with unit tests.
3. Create the scores HCS topic (backend submit key). Publish one snapshot per epoch (hourly for the demo): `{epoch, configVersion, inputsHash, agents:[{agentId, score, tier, counted, excluded}], creators:[{creator, score, P}]}`. Split it across chunks if it is large.
4. Cache the latest snapshot in a small database for the web app and the API.
5. Publish the config (weights, half-lives, penalties) with a version number.

**Manual tests**

- [ ] T5.1 Run on Phase 4 data. A1 = 90, Tier 1. The snapshot appears on the scores topic.
- [ ] T5.2 U's 0-value review from T4.5 is listed as excluded ("not human-backed"). A1 is still 90.
- [ ] T5.3 T4.6's review with the made-up payment is excluded ("payment not found").
- [ ] T5.4 Two creators' agents report `fraud` against A1 with verified payments. A1 drops, Creator A drops to at most 80 (100 − 20), and Creator B is unchanged.
- [ ] T5.5 A newly linked agent A3 with no reviews shows Creator A's current score and the "New" label.
- [ ] T5.6 Creator A reports A2 compromised, then A2 gets confirmed misconduct. A2 drops, and Creator A's P does not change.
- [ ] T5.7 Creator A's other agents get many 100-value reviews. Creator A stays at or below 100 − P.
- [ ] T5.8 Wipe the cache and rerun from scratch. The snapshot has the same `inputsHash` and identical scores.
- [ ] T5.9 Shift the clock forward 180 days in a test run. Creator A's P halves.

**Exit:** T5.1–T5.9 pass. The scores topic ID and config version are documented.

## Phase 6 — Web app

Goal: a creator can go from wallet connection to a live, public agent page in one sitting, and anyone can check an agent without signing in. Screen details are in the [UI Elements](04-ui-elements.md) doc.

**Milestones**

- **6a (the demo path):** Verify, Onboard agent, public Agent page.
- **6b:** Creator profile, Explorer, Leave a review.

**Stack**

- Next.js with wagmi + viem, using a custom Hedera testnet chain (ID 296, Hashio RPC) for MetaMask. HashPack via WalletConnect comes later.
- The World ID IDKit React widget
- Mirror Node REST for on-chain reads; the backend API for scores and search

**Backend endpoints**

| Endpoint | Purpose |
| --- | --- |
| `POST /api/verify` | World ID → `registerCreator` (Phase 2) |
| `POST /api/agent-file` | Host an agent file, return the URI and hash |
| `POST /api/review-file` | Post a review file to HCS (Phase 4) |
| `GET /api/agents?q=&humanBacked=&minScore=` | Search agents (from the scorer cache) |
| `GET /api/agents/:agentId` | Agent profile, score, tier, reviews, credentials, creator |
| `GET /api/creators/:address` | Creator score, P, agents |

**Tasks**

1. Wallet connection with a wrong-network check and a one-click network switch.
2. Verify screen wired to `POST /api/verify`, with polling until the creator record appears.
3. Onboard wizard covering Phase 3 steps 1–7. It saves progress so a closed tab can resume.
4. Public agent page built from the API and Mirror Node, with HashScan links on every on-chain item.
5. 6b screens.
6. Every transaction button shows waiting-for-signature, submitted, confirmed and failed states.

**Manual tests** (fresh browser profile each time)

- [ ] T6.1 Connect MetaMask on the wrong network. A "Switch to Hedera Testnet" banner appears, and its button switches networks.
- [ ] T6.2 Verify end to end as a new creator. The "Verified creator" badge appears within about 10 seconds, without a page refresh.
- [ ] T6.3 Visit /onboard as wallet U. The page sends the user to Verify first.
- [ ] T6.4 Onboard an agent end to end. The success screen shows the agent ID, HashScan links and the credential.
- [ ] T6.5 Close the tab after `register` but before `linkAgent`, then reopen. The app resumes at the Link step.
- [ ] T6.6 Reject a signature in the wallet. The app shows "Cancelled" with a retry button, and nothing breaks.
- [ ] T6.7 The agent page shows score, tier, Human-backed badge, creator score, reviews with payment-verified marks, and credentials.
- [ ] T6.8 The agent page loads with no wallet connected.
- [ ] T6.9 In the explorer, "Human-backed only" hides agents that are not linked.
- [ ] T6.10 On their own agent's page, the creator sees the review button disabled, with the reason.
- [ ] T6.11 At a 390 px wide screen, Verify, Onboard and the Agent page are all usable.

**Exit:** 6a tests (T6.1–T6.8, T6.11) pass for the demo. T6.9–T6.10 pass after 6b.

## Phase 7 — Agent SDK, API and MCP tools

Goal: agents can check and review each other in code, with the same rules as the web app.

**SDK functions** (TypeScript package, also exposed as REST)

| Function | Returns |
| --- | --- |
| `getAgent(agentId)` | Profile, score, tier, creator, creator score, credentials |
| `isHumanBacked(address)` | `true` / `false` |
| `verifyCounterparty(agentId, {minScore, humanBackedOnly})` | `{ok, reason}` — a gate to run before paying or hiring an agent |
| `review({agentId, value, tag1, tag2, paymentTxId, comment})` | The review transaction ID. Hosts the file, then calls `giveFeedback`. |

**Tasks**

1. Package the read functions on top of the backend API, and the write functions on top of viem with the caller's key.
2. Publish typed errors: `NOT_HUMAN_BACKED`, `SCORE_TOO_LOW`, `PAYMENT_NOT_FOUND`, `SELF_REVIEW`, `CHAIN_ERROR`.
3. Add a small MCP server exposing `get_agent`, `verify_counterparty` and `review_agent`, so LLM-based agents can use the layer directly.
4. Write a 20-line example script: agent B1 checks A1, pays it, then reviews it.

**Manual tests**

- [ ] T7.1 B1 runs `verifyCounterparty(A1, {minScore: 75})` before misconduct and gets `ok: true`. After T5.4 it gets `ok: false` with `SCORE_TOO_LOW`.
- [ ] T7.2 The example script runs end to end. The review shows on A1's page within one scorer epoch.
- [ ] T7.3 `review()` from Creator A's key on A1 returns `SELF_REVIEW`, and no transaction is sent.
- [ ] T7.4 `review()` from an account with no HBAR returns `CHAIN_ERROR`. A hosted file with no matching review is ignored by the scorer.
- [ ] T7.5 Through the MCP server, an assistant asked "Is agent \<A1 id> safe to hire?" calls `verify_counterparty` and reports the score and human-backed status.

**Exit:** T7.1–T7.5 pass. The package README shows the example script.

## Phase 8 — Demo script, hardening and mainnet readiness

Goal: a 5-minute demo that runs the same way every time, and a short list of what must change before mainnet.

**Demo script** (fresh accounts, staging World ID)

1. Creator A verifies with World ID. The "Verified creator" badge appears.
2. Creator A onboards "TradeBot A1". Show the agent page and the frozen credential on HashScan.
3. Creator B's agent B1 runs `verifyCounterparty`, pays A1 1 HBAR, and leaves a 90 review. A1 shows 90, Tier 1.
4. A1 fails a settlement. Two human-backed reviewers from different creators report misconduct. Next epoch: A1 drops, and Creator A drops.
5. Creator A tries to start over: same human, new wallet. World ID blocks a second creator record.
6. Creator A onboards A2. A2 starts at Creator A's lowered score. This is the payoff: reputation follows the human.

To keep the demo short, set the scorer epoch to 1 minute and pre-fund every account.

**Hardening**

- [ ] Separate keys for the admin, verifier and issuer roles. The verifier key lives in a secrets manager.
- [ ] Contract unit tests for every revert path. HTS paths are tested on a Hedera local node or testnet.
- [ ] API rate limits; Mirror Node backoff on HTTP 429.
- [ ] Scorer config is versioned and published. The snapshot includes `configVersion` and `inputsHash`.
- [ ] Error monitoring on the verifier and scorer, plus an alert if no snapshot is published for 2 epochs.
- [ ] Decide the upgrade policy for CreatorRegistry: immutable, or upgradeable behind a timelock.

**Before mainnet**

- [ ] ERC-8004 lists only a Hedera testnet deployment. Either deploy the Identity and Reputation registries on mainnet yourself, or wait for an official deployment.
- [ ] Switch the World ID app to production and require Orb-level verification.
- [ ] Replace the single verifier with 2-of-3 verifiers, and publish proofs so anyone can re-verify.
- [ ] Re-price fees at the live exchange rate.

**Manual tests**

- [ ] T8.1 Run the full demo script twice in a row on fresh accounts. Each run is under 5 minutes with no manual fixes.
- [ ] T8.2 Run the demo on a phone-width browser. Every step works.
- [ ] T8.3 Stop the scorer mid-demo, then restart it. It catches up, and its scores match a clean run.

**Exit:** T8.1–T8.3 pass. The demo video is recorded.

## Risks and open questions

The biggest risk is trust in our own verifier: until it is split across several parties, one server decides who counts as a human.

| Risk | Impact | Mitigation |
| --- | --- | --- |
| Single World ID verifier | It could register fake creators | 2-of-3 verifiers; publish proofs for re-verification |
| Fake negative reviews (griefing) | Honest creators lose score | Count only human-backed, paid reviews; weight by reviewer score; misconduct needs 2 creators |
| ERC-8004 is a draft standard, and its registries are upgradeable by their admin | The ABI or its behaviour could change | Pin ABIs; watch the spec repo; re-run Phases 3–4 tests after upgrades |
| No Hedera mainnet ERC-8004 deployment | Blocks the mainnet launch | Deploy our own copy, or wait |
| World ID adoption and biometric concerns | Fewer creators | Optional lower tier for unverified creators (open question) |
| Mirror Node lag of a few seconds | The UI looks stuck | Poll with progress states; show "confirming" |
| `0x167` gas estimates are unreliable | Failed transactions | Generous gas limits, tuned from real gas used |
| Agent lists are public per creator | A creator's agents can be linked to each other (not to the person) | State it at onboarding |

**Decisions to make**

- [ ] Who confirms misconduct: the 2-creator rule, an arbiter role, or our own deployment of the ERC-8004 Validation Registry?
- [ ] Penalty sizes (proposed: fraud 20, failed settlement 10) and half-lives (reviews 90 days, penalties 180 days).
- [ ] Orb-only, or also allow device-level World ID at a lower tier?
- [ ] Host agent and credential files on IPFS (needs a pinning service) or HCS-1?
- [ ] Scorer epoch length after the demo: hourly or daily?
- [ ] Should creators be able to move their creator record to a new wallet with a fresh World ID proof?

## Sources

- [ERC-8004 specification (EIP-8004)](https://eips.ethereum.org/EIPS/eip-8004)
- [ERC-8004 contracts and deployments](https://github.com/erc-8004/erc-8004-contracts)
- [HCS-25 AI Trust Score Methodology](https://hol.org/docs/standards/hcs-25/)
- [HCS-14 Universal Agent ID](https://hol.org/docs/standards/hcs-14/)
- [World AgentKit docs](https://docs.world.org/agents/agent-kit)
- [HTS system contract docs](https://docs.hedera.com/evm/hedera-services/system-contracts/hts)
- Hedera by Example labs: Module 8 Lab 8 (HTS from Solidity), Module 9 Labs 4–5 (HCS-11, HCS-14), Module 14 Lab 2 (HCS-25)
- Testnet registry contracts 0.0.7919997 and 0.0.7919998, checked on the Hedera Mirror Node on 2026-11-06
