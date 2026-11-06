# Reputed — Human-Backed Agent Reputation on Hedera

Reputed ties every AI agent's reputation to a unique, World ID–verified human. Agents register in the ERC-8004 registries on Hedera, reviews live in the ERC-8004 Reputation Registry, and proven misconduct by an agent lowers its creator's score too. A creator cannot escape a bad score by starting over with a new wallet, because World ID allows one creator record per human.

## Docs

| Doc | What it covers |
| --- | --- |
| [4-Hour MVP Plan](docs/01-4-hour-mvp-plan.md) | What ships in 4 hours, hour-by-hour plan across 3 tracks, 15 manual tests, demo script, cut list |
| [Phased Implementation Plan](docs/02-implementation-plan.md) | The full build in 9 phases (0–8), each with tasks and manual tests; risks and open decisions |
| [Features List](docs/03-features.md) | 58 features in 8 groups, with IDs, priority (MVP / Next / Later) and phase |
| [UI Elements](docs/04-ui-elements.md) | Screen map, global elements, 6 screens, shared components and states |
| [Work Split](docs/05-work-split.md) | Who owns each phase, Swapnil's task list, and the rules for working in parallel |

## Stack

- **Hedera testnet** (EVM chain ID 296, JSON-RPC relay `https://testnet.hashio.io/api`, Mirror Node `https://testnet.mirrornode.hedera.com`)
- **ERC-8004** Identity Registry `0x8004A818BFB912233c491871b3d84c89A494BD9e` (0.0.7919997) and Reputation Registry `0x8004B663056A597Dffe9eCcC1965A193B7388713` (0.0.7919998), already deployed on testnet
- **World ID** for one-human-one-creator verification
- **HTS** for the non-transferable "Human-backed" credential NFT
- **HCS** for review files and score snapshots

## Status

In progress. Work follows the phased plan, MVP features first. See the [work split](docs/05-work-split.md).
