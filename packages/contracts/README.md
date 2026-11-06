# Contracts

`CreatorRegistry` ties each agent to one World ID verified human, and owns the HTS credential collection. The plan is in [Phase 1](../docs/02-implementation-plan.md#phase-1--creatorregistry-contract-and-credential-nfts).

| Path | What it is |
| --- | --- |
| `src/CreatorRegistry.sol` | The contract |
| `src/interfaces/ICreatorRegistry.sol` | The fixed interface `apps/server` and `apps/web` build against |
| `src/hedera/` | `0x167` interface and the checked call wrappers in `Hts.sol` |
| `test/` | Unit tests. The doubles in `test/doubles/` exist only here |
| `script/` | Funding, deployment, ABI generation, the read-only preflight and the funded T1.9b check |
| `abi/` | Pinned ERC-8004 ABIs |
| `lib/` | Vendored forge-std v1.9.2 and OpenZeppelin 5.1.0 (access control, plus the EIP-712 and ECDSA files and what they import), with no submodules |

Needs Foundry, Node, `jq` and `python3`.

## Commands

Build and test. This needs no network:

```bash
cd contracts
forge build
forge test
bash test/env-checks.sh
```

Check the contract against Hedera's HTS logic, without signatures. This needs no keys or funds and writes nothing:

```bash
forge build && node script/preflight.mjs
```

Go live, once `OPERATOR_KEY` in the root `.env` holds a funded account. Deployment costs about 20 HBAR plus gas.

```bash
script/fund-accounts.sh      # tops every test account up to 10 HBAR. FUND_HBAR changes it
script/deploy.sh             # deploys, creates the collection, prints the .env lines
script/check-rollback.sh     # T1.9b, after the two lines below are in .env. Costs about 5 HBAR
```

Copy the two printed lines into `.env`. The script does not edit `.env`. If it fails after deploying, set `CREATOR_REGISTRY` and run it again: it skips the deploy and only creates the collection.

The operator is the admin. It is also the verifier and issuer unless `VERIFIER_KEY` or `ISSUER_KEY` is set. Set both before anything beyond testnet (OP-1). The scripts pass keys to `cast` as arguments, so they are visible to other processes on the same machine while it runs.

Regenerate the ABI after any contract change:

```bash
forge build && node script/generate-abi.mjs
```

Verify on HashScan. This command has not been run yet:

```bash
forge verify-contract --chain 296 --verifier sourcify \
  --verifier-url https://server-verify.hashscan.io "$CREATOR_REGISTRY" src/CreatorRegistry.sol:CreatorRegistry
```

## Environment

The scripts read the root `.env`, or the file in `ENV_FILE`. `fund-accounts.sh` needs these, which are all in `.env.example`:

```bash
CREATOR_A_ADDRESS=
CREATOR_B_ADDRESS=
CREATOR_C_ADDRESS=
AGENT_A1_ADDRESS=
AGENT_A2_ADDRESS=
AGENT_B1_ADDRESS=
AGENT_C1_ADDRESS=
WALLET_U_ADDRESS=
WALLET_U_KEY=
```

`WALLET_U_KEY` is only for the T1.5 command at the end of this file.

`OPERATOR_KEY`, `VERIFIER_KEY` and `ISSUER_KEY` must be raw 32-byte ECDSA keys in hex, with or without `0x`. The scripts stop on anything else, such as the portal's DER export, without printing the value. A raw Ed25519 key looks the same and cannot be detected: `cast` accepts it and derives an address with no funds. The account has to be ECDSA.

## Gas limits

`0x167` estimates are unreliable, so always set the limit explicitly. **The plan's 1,000,000 is too low for any call that auto-associates the holder**, and that is the normal case, because faucet and hollow accounts have unlimited auto-association.

| Call | Simulated gas | Limit to use |
| --- | --- | --- |
| `registerCreator` | about 50,000 | 200,000 |
| `initCredentialToken` | about 172,000, plus the fee sent as value | 1,000,000 |
| `issueCredential`, holder already associated | about 345,000 | 1,500,000 |
| `issueCredential`, holder auto-associated | about 1,050,000 | 1,500,000 |
| `linkAgent`, wallet already associated | about 468,000 | 1,500,000 |
| `linkAgent`, wallet auto-associated | about 1,170,000, worked out from the row above and the `issueCredential` gap | 1,500,000 |
| `linkAgentWithGrant`, wallet auto-associated | 1,245,313 (testnet) | 1,500,000 |
| `linkAgentWithGrant`, wallet already associated | 523,512 (testnet) | 1,500,000 |
| `authorizeGrant` | 51,667 (testnet) | 300,000 |
| `revokeGrant` | not measured | 200,000 |
| `syncAgentWallet`, wallet already associated | about 400,000 | 1,500,000 |
| `syncAgentWallet`, wallet auto-associated | about 1,100,000, worked out the same way | 1,500,000 |
| `revokeCredential` | about 56,000 | 300,000 |
| `reportCompromise` | not measured, no `0x167` call | 200,000 |

Hedera charges for gas used, not the limit, at about 124 tinybar per gas today: on testnet a transaction with a 3,000,000 limit that used 102,501 gas was charged 0.127 HBAR. So a `linkAgent` that auto-associates costs about 1.5 HBAR, and a generous limit costs nothing extra. The sender still needs a balance that covers the limit, about 1.9 HBAR for 1,500,000. Lower the limits once the Mirror Node shows real use.

`forge test` models no gas, so it cannot catch a limit that is too low: `linkAgent` passes there at 1,000,000. These limits are only enforced by whoever sends the call, so `apps/web` and any server call must set them.

## Credential delivery

Issuing mints to the treasury, delivers, then freezes. The holder's state at the start decides what happens:

| Holder | Steps | Result |
| --- | --- | --- |
| Frozen, so it already holds a credential | unfreeze, transfer, freeze | Delivered (T1.8) |
| Associated, not frozen | transfer, freeze | Delivered (T1.6) |
| Not associated, free auto-association slot | transfer associates it, freeze | Delivered |
| Not associated, zero slots | transfer fails | Reverts with 184 `TOKEN_NOT_ASSOCIATED_TO_ACCOUNT` (T1.5, T3.6) |
| Not associated, all slots used | transfer fails | Reverts with 262 `NO_REMAINING_AUTOMATIC_ASSOCIATIONS` |
| No Hedera account at that address | `isFrozen` fails | Reverts with 15 `INVALID_ACCOUNT_ID`, before minting |
| `receiverSigRequired` is true | transfer needs the holder's signature, which this call cannot carry | **Unverified.** Expected to revert. The simulator delivers, but it checks no signatures, so that says nothing. The double fails it |

The sequence branches on `isFrozen` because neither freeze call can be made blindly: `unfreezeToken` fails on an unassociated account, and `freezeToken` fails with 165 on an account that is already frozen. `isFrozen` answers false for a live account with no association, which covers both.

`freezeDefault` must stay false. On a default-frozen token auto-association fails, so holders with free slots could never receive a credential.

Revoking unfreezes, wipes and refreezes, because wiping also fails on a frozen account. The holder stays frozen even with no credentials left, and the next issue handles that.

Any failed step reverts the whole call, and that revert is the only thing that stops a failed revoke or issue leaving a holder unfrozen. This is confirmed on Hedera testnet: `script/check-rollback.sh` is T1.9b, and it passed both as a plain transaction and through a contract that catches the revert. See [Evidence](#evidence).

The surplus from `initCredentialToken` stays in the contract, because the network only charges the fee. The contract is the token's auto-renew payer, and there is no withdraw function.

Metadata is 1 to 100 bytes. `linkAgent` writes `reputed:human-backed:<agentId>`, which fits for every `uint256`.

## What isHumanBacked means

This flag gates which reviews count, and the Identity Registry changes wallets and owners without telling this contract. So a recorded wallet is only a hint, and every call re-checks live state. It returns true when either of these holds:

- The wallet is a registered creator.
- The wallet was linked or synced to an agent, no agent recorded on that wallet has been reported compromised, and for at least one of those agents both of these are true now: `getAgentWallet` still returns that wallet, and `ownerOf` is still the agent's creator.

| Event | Effect |
| --- | --- |
| `setAgentWallet` to a new wallet | Old wallet is false at once. The new wallet is false until `syncAgentWallet` |
| `syncAgentWallet` by the agent's creator | New wallet is true and gets a frozen credential. Emits `AgentWalletSynced` |
| Wallet set back to a linked or synced wallet | True again, with no sync needed |
| Agent NFT transferred | False, because the transfer clears the wallet |
| New owner points the agent back at the old wallet | False, because the owner is not the creator |
| NFT returns to the creator and the wallet is set again | True again |
| `reportCompromise`, agent has its own wallet | False for every wallet recorded for that agent, permanently |
| `reportCompromise`, wallet shared with other agents | False. One report voids the wallet for all of them, because they share the key |
| `reportCompromise`, wallet is the creator's own address | **No change.** Creator wallets stay true |
| Identity Registry call fails | False, and the view does not revert |
| `revokeCredential` | No effect. The flag and the credential are independent |

### syncAgentWallet

This is the recovery for a lost or stolen wallet key, and the one addition to the plan's interface. It is a separate function from `linkAgent` and is not in `ICreatorRegistry`, so nothing built against that interface changes. Use it after `setAgentWallet`:

- Only the agent's creator can call it, and only while the creator still owns the NFT.
- It reverts if the agent is compromised, the wallet is clear, or the wallet is already linked or synced (`WalletAlreadyLinked`).
- The wallet must be able to receive the credential, exactly as for `linkAgent`. T3.6 applies: an unassociated wallet reverts with 184 and the call can be retried.
- The new wallet signed `setAgentWallet`, so a creator cannot vouch for a wallet that did not agree to it.

### The compromise rule

A compromise report means the key is untrusted, so the wallet stops counting. Creator wallets are the exception. A creator wallet is the World ID verified identity and its nullifier can only register once, so voiding it would lock that human out for good.

**Default-wallet agents get no wallet-level protection.** If an agent's wallet is the creator's address, which is the plan's default flow, a report changes nothing in `isHumanBacked`. A stolen creator key keeps casting counted reviews. Anything that needs to stop that has to do it in the scorer, from `compromisedAt`.

The rule fails closed in two ways to know about. A report voids every wallet recorded for that agent, including ones it has already moved off, because a report cannot say which key it means. And it voids a wallet for other creators' agents too, if the wallet signed up for both.

`isHumanBacked` answers for now, not for a past date. After a compromise report, the scorer sees the wallet as unbacked for its earlier reviews too.

### The credential is not the authority

**`isHumanBacked` is the authority, not the NFT.** Nothing in the contract removes a credential when backing ends, so after a sale, a rotation or a compromise report the old wallet still holds a frozen `reputed:human-backed:<agentId>` NFT, and the holder cannot remove it. After a report `getAgentWallet` still names that wallet, so an agent page reading the wallet's NFTs would show a credential the view denies. Never treat holding the NFT as proof of backing.

Clearing stale credentials takes an issuer job, which is **not built**. It belongs in `apps/server`, because it needs the issuer key:

| Trigger | Revoke |
| --- | --- |
| Identity Registry `Transfer` of a linked agent | Every serial from that agent's `AgentLinked` and `AgentWalletSynced` events |
| `AgentCompromised` | The same |
| `AgentWalletSynced`, or the agent's wallet changing | The serial held by the wallet the agent left |

For each one, call `revokeCredential(holder, serial)`. The holder and serial are in those two events, so no on-chain lookup is needed. It has to skip serials already revoked, using `CredentialRevoked`, because a repeat fails with 226. Rotating back to a wallet whose credential was revoked leaves it backed with no credential, and the issuer can reissue with `issueCredential`.

Wiping inside `reportCompromise` was rejected. A wipe can fail, and a creator must always be able to report.

## Grants: linking without the creator's wallet

`linkAgent` needs the creator's own wallet to own the agent NFT. An agent built with the Hedera Agent Kit owns its own NFT and has no creator wallet, so v2 adds grants (EIP-712 domain `ReputedCreatorRegistry`, version `2`):

| Call | Who | What it does |
| --- | --- | --- |
| `authorizeGrant(grantKey, expiresAt, maxAgents)` | A registered creator | Lets the address `grantKey` link up to `maxAgents` agents before `expiresAt`. A key belongs to its first creator for good |
| `revokeGrant(grantKey)` | The grant's creator | Stops new links. Agents already linked stay linked; report them one by one with `reportCompromise` |
| `linkAgentWithGrant(agentId, grantKey, deadline, signature)` | The agent's owner | Links the agent to the grant's creator. `grantKey` must have signed `LinkGrant(uint256 agentId,address owner,uint256 deadline)` with `owner` equal to the caller |

The signature covers the agent and the caller, so it cannot be moved to another agent or sent by someone else. The link emits `AgentLinked` as before, plus `AgentLinkedByGrant` with the owner. `linkedOwner(agentId)` records who owned the NFT at link time, and `isHumanBacked` stops counting the agent when the NFT leaves that address. For `linkAgent` that is the creator, so classic behaviour is unchanged.

`linkAgentWithGrant` costs the same gas as `linkAgent` (use 1,500,000) and the agent's account pays it.

Not supported for grant-linked agents yet: `syncAgentWallet` (it needs the creator to own the NFT). Onboard a new agent to change wallets.

## Errors

The contract uses custom errors, all in the ABI. A failed `0x167` call gives `HtsCallFailed(selector, responseCode)`, or `HtsCallReverted(selector, reason)` if the system contract reverted. For T3.6, look for `HtsCallFailed` with code 184 and tell the user to associate the wallet.

## Evidence

| Check | Status |
| --- | --- |
| `forge test` | Passes, using the HTS double |
| `bash test/env-checks.sh` | Passes |
| `node script/preflight.mjs` | Passes through Mirror Node simulation of Hedera's code on live testnet state, including the real Identity Registry. It covers T1.2, T1.5 to T1.9, T3.4, T3.8 and `syncAgentWallet`, within the limits below |
| Script mechanics | `deploy.sh` and `check-rollback.sh` run on a local anvil chain with the double at `0x167`, and `check-rollback.sh` used a stand-in for the Mirror Node. Not run on testnet |
| T1.9b, rollback on Hedera | **Passed on testnet, 2026-11-06.** Top level `0x88cba56a8ada68ee74dd6a91a5775c7ffc279352e2121dfce5629d33e5df853a`, nested `0x5529083c827902f63f1ed4fe08b752ea2639e594f5d15398008aa902752a292f`. The holder stayed FROZEN with the same balance and supply after each |
| Any transaction on testnet | **Not done.** No account is funded |

The preflight is strong evidence for HTS rules, but simulation is not consensus. A deliberately wrong struct layout fails it, so it does check the encoding. Scenario 9 prints two things it does not do:

- **It never rolls back a nested revert.** A plain contract doing `value = 1; revert()` keeps `value = 1`, with no HTS call involved. After `revokeCredential` with a wrong serial, the holder reads as not frozen. So this is a simulator limit, and neither that result nor an earlier one, where a failed `issueCredential` left the mint in the supply, says anything about consensus.
- **It checks no signatures or keys.** A contract without the freeze key gets a success code when it freezes a holder. In a one-off run, the same held for a stranger moving another account's NFT and for one contract associating another. Everything that depends on authority is unproven: the contract key on the collection, the treasury signing its own transfer, and `receiverSigRequired`.

That is why T1.9b had to run on the real network. The script issues a credential to a test wallet so it is frozen, then runs a failing `revokeCredential` two ways: as a plain transaction, and through `RollbackProbe`, which catches the revert so that the transaction succeeds and only the nested frame unwinds. After each, it requires the Mirror Node to show `freeze_status` FROZEN and the same balance and `total_supply`, and it confirms the call failed at the wipe and not earlier. It then revokes the test credential and removes the probe's role.

If T1.9b ever fails after a redeploy, a failed revoke leaves a credential transferable, and that needs fixing before anything else.

## Running T1.5 on testnet

Wallets funded by `fund-accounts.sh` have unlimited auto-association, so `issueCredential` to them succeeds instead of failing. To get the T1.5 failure, turn auto-association off from the wallet first. The call goes to the wallet's own address:

```bash
cast send --rpc-url https://testnet.hashio.io/api --private-key "$WALLET_U_KEY" --gas-limit 200000 \
  "$WALLET_U_ADDRESS" 'setUnlimitedAutomaticAssociations(bool)' false
```

To associate that wallet afterwards for T1.6, call `associate()` on the token's EVM address, the long-zero form of `CREDENTIAL_TOKEN_ID`, from the same wallet.

### Testnet deployment

Deployed 2026-11-06. Source verified on Sourcify with an exact creation and runtime match.

| Item | Value |
| --- | --- |
| CreatorRegistry | `0x424afbefd2d91cd771785909bfc9aeb66e89a80a` (0.0.11339496) |
| Credential token | 0.0.11339521 |
| Reviews topic | 0.0.11339620 |
| Scores topic | 0.0.11339621 |

| Test | Result on testnet |
| --- | --- |
| T1.1 | Passed. `identityRegistry()` returns `0x8004A818…BD9e`, and the source is verified |
| T1.2 | Passed. `NON_FUNGIBLE_UNIQUE`, treasury is the contract, and the supply, freeze and wipe keys all decode to contract 0.0.11339496 |
| T1.3 | Passed. Reverted for wallet U, `0x9bc9844fb1283f1fb09efc2133ba3beb4b54b8b0fc9ccf95c23dff79e9d2422` |
| T1.4 | Passed on a throwaway address. Same nullifier and same wallet both revert |
| T1.5 | Not run. Needs a wallet with no free association slots; faucet wallets auto-associate |
| T1.6 | Passed. Serial delivered, holder FROZEN |
| T1.7 | Passed. The transfer failed with 165 (`ACCOUNT_FROZEN_FOR_TOKEN`), `0x6750ae9046d8c5dc0c7422038e7049c8255de231598aa545a4cce37e0c1326f2` |
| T1.8 | Passed. Second credential delivered to the frozen holder, which ended FROZEN with balance 2 |
| T1.9 | Passed. Serials removed, supply back to 0, holder still FROZEN |

Real gas: deploy 1,988,234. `issueCredential` to an already associated wallet 369,368. `revokeCredential` 83,081. `registerCreator` 71,089.

Phase 3 passed on testnet with `apps/server/scripts/testnet-phase3.ts`, using two test-only creators registered directly with the verifier key, not through World ID. T3.1–T3.5 and T3.7–T3.9 passed, and T3.6 was not run. Agents 159, 160 and 162 belong to the first test creator, and 163 to the second. Real gas: `register` 454,322, `linkAgent` 1,208,089 with auto-association and 503,376 without.

### Testnet deployment of v2 (grants)

Deployed 2026-11-07 as a new contract, because grants add functions and a new credential collection (the old collection's keys belong to the old contract).

| Item | Value |
| --- | --- |
| CreatorRegistry v2 | `0xcbd506592be9f52ae48196d592df8919c9fa4dd2` (0.0.11344727) |
| Credential token | 0.0.11344804 |
| CreatorRegistry v1 | `0x424afbefd2d91cd771785909bfc9aeb66e89a80a`, no longer used |

The source is verified on Sourcify (chain 296, exact runtime match). HashScan's own Sourcify endpoint answered 404 for this, so it was submitted to the main server: add `--constructor-args` and leave out `--verifier-url`.

Creating the collection takes **17.5 HBAR** as the value of `initCredentialToken`: a `cast call` simulation accepted 17.5 and refused 17.4, so the fee is about 17.45 HBAR. `deploy.sh` defaults to 20; use `INIT_HBAR=17.5`. Deploying the contract used 3.45 HBAR.

`script/migrate-creators.sh` replayed the 5 creators of v1 into v2 with the verifier role, so nobody redoes World ID. Agents linked on v1 are not carried over: link them again.

`packages/agent-kit/scripts/testnet-e2e.ts` ran the whole flow on testnet and passed: a creator authorized an API key, a funded agent account registered and linked itself in 11 seconds for 2.11 HBAR (agent 168, credential serial 3), a second run sent nothing, the server showed the agent human-backed and active, and after `revokeGrant` a new agent was refused with `GRANT_REVOKED` before anything was registered. `linkedOwner` equals the account's Mirror Node `evm_address`, so an ECDSA account owns its agent NFT under its alias address. Real gas: `register` 454,226, `linkAgentWithGrant` 1,245,313 with auto-association and 523,512 without.
