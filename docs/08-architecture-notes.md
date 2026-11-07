# Architecture Notes

Nov 7, 2026

The design decisions that are easy to miss when reading the code file by file. Each one points at the function that implements it. The code comments say the same things in more detail next to the code.

## The identity model

**One human, one creator, for good.** `CreatorRegistry.registerCreator` maps a World ID nullifier to exactly one wallet and a wallet to exactly one nullifier. There is no update or removal path, so a spent nullifier can never register again. This is the property everything else rests on: a creator cannot escape a bad score by starting over, because World ID will not give the same person a second creator record.

**The creator link is written once.** `linkAgent` records `creatorOf(agentId)` and never clears it. Selling the agent NFT does not move the agent to the buyer. What ends human-backing on a sale is `_backsWallet`, which compares the registry's live `ownerOf` with the owner recorded at link time.

**`isHumanBacked` fails closed.** The wallet list stored in the contract is only a hint. Every call re-reads `getAgentWallet` and `ownerOf` from the ERC-8004 Identity Registry inside try/catch, because the registry changes wallets and owners without notifying this contract.

**The credential is a frozen HTS NFT.** `_issueCredential` mints to treasury, transfers, then freezes, branching on `isFrozen` because `unfreezeToken` fails on an unassociated account and `freezeToken` fails on an already-frozen one. Any non-SUCCESS step reverts the whole call, which is the only thing that prevents a credential from ending up transferable. The collection has freeze, wipe and supply keys held by the contract and no admin key, so keys and treasury are fixed for life. `revokeCredential` unfreezes, wipes and refreezes in one call; a failed wipe relies on the revert undoing the unfreeze, which was confirmed on testnet both as a plain transaction and through `RollbackProbe.revokeAndCatch`.

**HTS calls carry their selector in the error.** `Hts._call` makes low-level calls to `0x167` (extcodesize checks do not hold for system contracts) and raises `HtsCallReverted(selector, reason)` or `HtsCallFailed(selector, code)`, so a multi-step issue reveals which step failed. Code 184 on `transferNFT` means "ask the user to associate".

## API keys and headless onboarding

**The server never sees the key.** `shared/grant.ts` draws 32 random bytes in the creator's browser (`rpk_test_…`), derives a signing key as `keccak256('reputed-grant-v1' ‖ secret)` rather than using the secret directly, and only the derived address goes on-chain via `authorizeGrant(address, expiresAt, maxAgents)`. No error message echoes the key, and tests assert this.

**The agent's own account links itself.** `linkAgentWithGrant` takes an EIP-712 `LinkGrant(agentId, owner, deadline)` signed by the grant key. `owner` must equal `msg.sender`, so an intercepted signature is useless to anyone else, and the deadline is 600 seconds. The creator's wallet is never involved; the agent account sends and pays every transaction. A grant key belongs to its first creator for good, and its expiry and agent cap cannot be edited, so a revoked or exhausted key cannot be re-pointed.

**Nothing is registered before the grant is checked.** `agent-kit/onboard.ts` reads the grant on-chain before `resolveAgent`, and again at the top of `register`, so an unknown, revoked, expired or used-up key is refused before any gas is spent.

**The chain is the source of truth; the state file is a hint.** `resolveAgent` tries, in order: an explicit `agentId`, the state file (dropped if `ownerOf` disagrees), a pending registration, the account's own `register` calls on the Mirror Node matched by name, and only then a new registration. A lost state file does not cause a second registration. `register` writes the URI and start time to the state store before sending, saves the transaction ID after, and recovers a crash in between by matching the URI against the registry's `Registered` logs. `FileStateStore.save` writes a pid-named temp file and renames it, so a crash leaves the previous file intact.

**Linking is idempotent, so it needs no pre-send state.** A repeated `linkAgentWithGrant` reverts with `AlreadyLinked`, which the loop handles by re-reading `creatorOf`.

**Association only when it is certain to be needed.** An explicit `associate` is sent only when the account has zero automatic association slots. If HTS still reverts with 184 or 262, the loop associates and re-sends exactly once.

**Reads go to the Mirror Node, not the relay.** `agent-kit/mirror.ts` uses `POST /contracts/call`, turns reverts into `CallReverted` distinct from `MIRROR_ERROR`, retries 429 and 5xx with exponential backoff, and never retries 404, which means "not indexed yet". Receipts give status only; results and revert data come from polling the Mirror Node.

**Gas is sized from the agent file.** `shared/gas.ts` scales the register gas linearly with URI bytes, because the file is stored on-chain, and `agentFile.ts` predicts the server's padded data-URI length client-side so gas can be sized before posting. The balance check is against the gas limit plus 0.1 HBAR headroom, re-read before each send.

**Gate decisions are return values; only check failures throw.** `verifyCounterparty` returns `{ ok: false, reason }` for compromised, not human-backed or low score, and throws `ReputedError` only for bad input, 404 or an unreachable API. The Agent Kit plugin and the MCP server both convert thrown errors into tool results carrying the code, so the model's run does not die.

## The indexer

**Lag, not reorgs.** Each sync reads the Mirror Node's latest fully-ingested consensus time from `/blocks?limit=1`, ingests, then folds only events up to that time. Rows are append-only (`INSERT OR IGNORE` on `(source, ts, log_index)`) and the cursor resumes with `gte` because one timestamp can hold several logs and a page can end between them.

**The cursor moves with its page.** `store.saveLogPage` writes events and cursor in one SQLite transaction, so a crash cannot move the cursor past unsaved events. `bindSource` keys events to the configured contract address; a changed address wipes and re-reads only that source, so the fold never mixes two deployments.

**Facts are time-scoped.** Every cached review file, payment and account carries `fetchedThrough`. A found fact is final; a miss only proves absence up to its lookup time; anything that reached consensus after the review counts as absent. A rebuilt cache therefore yields the same `inputsHash`.

**Mirror outages hold the epoch.** Only a `{"_status":…}` 404 from the Mirror Node itself is a miss. 429, 5xx and plain-text 404s back off (honouring Retry-After) and then raise `MirrorError`, which marks the review unresolved and sets `pending > 0`, and `publishEpoch` refuses to publish. An outage can delay a score but never turn into "payment not found".

**Lookups are rationed.** Anyone can pile reviews onto an agent in the shared registry. Linked agents are enriched without limit, since an epoch cannot publish without them. Visitor-requested agents get a per-request and per-sync budget, a per-IP limit and a process-wide gate, and concurrent visitors to one agent share one in-flight lookup.

## Scoring

**Human-backed is replayed from events.** `isHumanBacked` only answers for now, so `scoring/wallets.ts` rebuilds per-wallet binding periods from link, sync, metadata, transfer and compromise events and judges each review at its own consensus time.

**Payment proof is net flow, single use, first-eligible-wins.** A payment counts only if it succeeded, precedes the review, and in some asset the agent's wallet-at-that-moment gained what the reviewer lost. Paying only the fee on someone else's transfer fails. The resolved Mirror transaction ID is claimed by the first review that passes the file, value, human-backed and payment rules; a revoked review frees its payment. The web app checks the same rule client-side before the reviewer signs, and reads earlier reviews' HCS files to grey out payments already cited.

**Transaction IDs are normalized.** `scoring/txid.ts` accepts SDK `0.0.x@s.n`, Mirror `0.0.x-s-n` and 32-byte EVM hashes, zero-pads nanos so one transaction cannot be cited twice under two spellings, and rejects IDs the Mirror Node would answer 400 or 503 to, because the 503 case would otherwise retry forever and block every epoch.

**One vote per creator, floor 0.2, 90-day half-life, cap not subtraction.** `weightedAverage` weights each review by `max(0.2, creatorScore/100) × 0.5^(age/90)`, divided by the number of reviews that creator left on the agent. `agentScore` is `min(average, 100 − penalties)`, so a value-0 fraud report lowers the average once and the penalty only caps.

**Circular weights are solved by a bounded fixed point.** Reviewer weights depend on creator scores, which depend on agent scores. `computeScores` starts creators at their cap, iterates at most 32 rounds on rounded values, then derives creators once more from the final agent scores, so published creator and agent scores are always mutually consistent. No previous snapshot is read.

**Misconduct is confirmed by two creators, once per window.** `confirmMisconduct` walks reports per agent and category in consensus order. It confirms when open, unrevoked reports within 30 days come from two distinct creators, allows one incident per window, sits confirming reporters out for 180 days, and keeps a confirmation final even if a report is later revoked. `decay()` rounds to 1e-12 so `Math.pow` differences between engines cannot reach a published score.

**The compromise cut-off is dated by first report.** A penalty whose first report preceded `reportCompromise` still counts against the creator, so a creator cannot watch the first report land and then report compromise before the second. `reportCompromise` itself allows exactly one report per agent, so the cut-off timestamp cannot be moved, and makes no HTS call because a report must always succeed.

**Snapshots are reproducible.** `inputsHash` is computed over canonical JSON of the as-of time, config, creators, agents, reviews and accounts, with nothing about fetch time. `configVersion` and `epochSeconds` define a series. On start the scheduler reads the newest snapshot of its own series from the HCS topic, rebuilds that epoch and logs whether the hash matches, which also stops double-publishing after a crash or a wiped cache.

## World ID verification

**Server-signed request, wallet-bound signal, local policy before World.** The action comes from config, so the signature endpoint cannot sign for anything else. The server checks environment, action, a single protocol version, exactly one response, Orb credential, signal hash equal to the wallet, nullifier within the BN254 field, and an EIP-191 wallet signature over the nonce, and only then calls World. There is no nonce list: a replay for the same wallet hits the registered nullifier, and for another wallet fails the signal check. The per-wallet rate limit is applied only after the signature passes, so nobody can burn another wallet's quota. In-flight claims stop two concurrent requests for one nullifier from both paying for a transaction, and a `verified` store row lets the same wallet retry on-chain without a second World ID scan.

**Failures carry a retry mode.** Because the World ID action allows one verification per person, the web app distinguishes `resend` (same proof again, for network, rate-limit or chain errors) from `restart` (a new scan, only when the proof itself is bad).

## The web app's transaction model

**The Mirror Node is the source of truth for outcomes.** `confirmTx` polls the Mirror Node rather than trusting relay receipts, because the relay returns 400 and 502 while a transaction is settling. A non-200 answer is `unknown`, never a failure. Polling flags "slow" at 30 seconds and stops at 180, leaving the outcome unknown until the user refreshes.

**A transaction is never auto-resent from an unknown state.** `TransactionButton` classifies wallet errors into "certainly not sent" (rejection, insufficient funds, chain mismatch) and "outcome open". From the open state it searches Hedera with the caller's `findSent` for 180 seconds and only after a clean search found nothing does it offer to send again, with a caller-supplied statement of the risk. An unreachable Mirror Node keeps sending locked.

**Reads bypass the relay.** `chainClient.mirrorCall` tries the Mirror Node's `/contracts/call` first because the relay's error responses lack CORS headers, so a throttled read in a browser looks like a dead connection. A revert is rethrown as a viem RPC error so custom errors decode normally.

**Sign-in is one free signature.** An EIP-191 signature is exchanged for a stateless HMAC token with a constant-time check. A remembered wallet supplies the address for reading after a reload; anything that signs requires a live connection, and the UI branches on that.

**Attempts are journaled before the wallet is asked, as hints only.** Payments and reviews record start time, amount or draft, and later the hash in local storage so a reload resumes watching or searching. A lost payment is found on Hedera by amount since the start time; a lost review by a `NewFeedback` log matched on `feedbackHash`. Nothing in storage is trusted until the Mirror Node confirms it.

**The review file is signed before the transaction.** The reviewer signs the exact serialized bytes, the server publishes them to HCS and returns `feedbackUri` and `feedbackHash`, and only then does the wallet sign `giveFeedback`. Serialization fixes key order and checksums CAIP-10 addresses so one review always hashes the same way.
