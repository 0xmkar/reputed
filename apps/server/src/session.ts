// Wallet sign-in. The client signs sessionMessage(wallet, issuedAt) once; the server answers
// with an HMAC token good for seven days. There is no session table: the token is the session,
// and SESSION_SECRET (or its derivation from RP_SIGNING_KEY) is what makes it verifiable.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { getAddress, isAddress, type Address } from 'viem';

export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** How far a wallet signature's timestamp may be from the server's clock. */
export const SIGN_IN_WINDOW_SECONDS = 5 * 60;

export interface SessionClaims {
  wallet: Address;
  /** Unix seconds. */
  expiresAt: number;
}

export interface SessionResponseParts {
  token: string;
  expiresAt: number;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString('base64url');
const mac = (secret: string, body: string) => createHmac('sha256', secret).update(body).digest();

/** `<claims>.<hmac>`, both base64url. Stateless, so a restart keeps every session alive. */
export function issueSessionToken(secret: string, wallet: Address, nowSeconds: number): SessionResponseParts {
  const expiresAt = nowSeconds + SESSION_TTL_SECONDS;
  const body = b64(JSON.stringify({ w: getAddress(wallet), e: expiresAt }));
  return { token: `${body}.${b64(mac(secret, body))}`, expiresAt };
}

/** The claims of a token this server issued that has not expired, or null. */
export function readSessionToken(secret: string, token: string, nowSeconds: number): SessionClaims | null {
  const [body, tag, ...rest] = token.split('.');
  if (!body || !tag || rest.length > 0) return null;

  // MAC first, in constant time: unauthenticated input never reaches JSON.parse.
  const given = Buffer.from(tag, 'base64url');
  const expected = mac(secret, body);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  try {
    const { w, e } = JSON.parse(Buffer.from(body, 'base64url').toString()) as { w?: unknown; e?: unknown };
    if (typeof w !== 'string' || !isAddress(w) || typeof e !== 'number' || e <= nowSeconds) return null;
    return { wallet: getAddress(w), expiresAt: e };
  } catch {
    return null;
  }
}
