import { bytesToHex, concat, isAddress, keccak256, stringToHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { HEDERA_TESTNET } from './constants';

// A creator's API key is 32 random bytes made in the browser. The grant key is derived from it, and
// only that key's address goes on-chain (CreatorRegistry.authorizeGrant). The Reputed server never
// sees the secret, so it cannot link an agent to anyone.
//
// Everything here runs in both the browser (the dashboard mints and authorizes keys) and Node (the
// agent signs with one), so it uses btoa/atob and WebCrypto rather than Buffer. No function ever
// puts the key into an error message, so a failed parse is safe to log.

export const API_KEY_PREFIX = 'rpk';
/** Mixed into the key derivation so the signing key is specific to this scheme and version. */
const DERIVATION_TAG = 'reputed-grant-v1';
/** The EIP-712 domain of CreatorRegistry v2. */
export const GRANT_DOMAIN_NAME = 'ReputedCreatorRegistry';
export const GRANT_DOMAIN_VERSION = '2';

export type ApiKeyEnvironment = 'test' | 'live';

export class InvalidApiKeyError extends Error {
  constructor() {
    super('Not a Reputed API key. Create one on the dashboard; it looks like rpk_test_… .');
    this.name = 'InvalidApiKeyError';
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

/** A new API key: `rpk_<environment>_<43 characters of base64url>`. Show it once. */
export function newApiKey(environment: ApiKeyEnvironment = 'test'): string {
  const secret = globalThis.crypto.getRandomValues(new Uint8Array(32));
  return `${API_KEY_PREFIX}_${environment}_${toBase64Url(secret)}`;
}

export function parseApiKey(apiKey: string): { environment: ApiKeyEnvironment; secret: Hex } {
  // base64url uses "_" too, so the key is matched as a whole instead of split on underscores.
  const match = /^rpk_(test|live)_([A-Za-z0-9_-]+)$/.exec(apiKey.trim());
  if (!match) throw new InvalidApiKeyError();
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(match[2] as string);
  } catch {
    throw new InvalidApiKeyError();
  }
  if (bytes.length !== 32) throw new InvalidApiKeyError();
  return { environment: match[1] as ApiKeyEnvironment, secret: bytesToHex(bytes) };
}

/**
 * The private key behind a creator's API key. It signs LinkGrant messages. The secret itself is
 * never used as a private key: the signing key is keccak256(tag ‖ secret), so the value a creator
 * pastes into an agent's environment and the value that signs are different bytes.
 */
export function grantPrivateKey(apiKey: string): Hex {
  const { secret } = parseApiKey(apiKey);
  return keccak256(concat([stringToHex(DERIVATION_TAG), secret]));
}

/** The address the creator authorizes on-chain for this API key. */
export function grantAddress(apiKey: string): Address {
  return privateKeyToAccount(grantPrivateKey(apiKey)).address;
}

export interface LinkGrantInput {
  creatorRegistry: Address;
  agentId: bigint;
  /** The agent's account: the caller of linkAgentWithGrant and the owner of the agent NFT. */
  owner: Address;
  /** Unix seconds. The contract refuses the link after this time. */
  deadline: bigint;
  chainId?: number;
}

/**
 * The EIP-712 message CreatorRegistry.linkAgentWithGrant recovers. `owner` must equal the caller, so
 * a signature is good for one agent, one sender and a window ending at `deadline`: it cannot be moved
 * to another agent or replayed by someone else. Both sides must hash exactly this struct.
 */
export function linkGrantTypedData(input: LinkGrantInput) {
  if (!isAddress(input.creatorRegistry) || !isAddress(input.owner)) throw new TypeError('Invalid address');
  return {
    domain: {
      name: GRANT_DOMAIN_NAME,
      version: GRANT_DOMAIN_VERSION,
      chainId: input.chainId ?? HEDERA_TESTNET.id,
      verifyingContract: input.creatorRegistry,
    },
    types: {
      LinkGrant: [
        { name: 'agentId', type: 'uint256' },
        { name: 'owner', type: 'address' },
        { name: 'deadline', type: 'uint256' },
      ],
    },
    primaryType: 'LinkGrant',
    message: { agentId: input.agentId, owner: input.owner, deadline: input.deadline },
  } as const;
}

/** Signs LinkGrant with the key behind the API key. Pass the result to linkAgentWithGrant. */
export function signLinkGrant(apiKey: string, input: LinkGrantInput): Promise<Hex> {
  return privateKeyToAccount(grantPrivateKey(apiKey)).signTypedData(linkGrantTypedData(input));
}

