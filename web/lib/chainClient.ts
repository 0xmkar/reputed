import { RpcRequestError, createPublicClient, custom, http, type Hex } from 'viem';
import { HEDERA_TESTNET } from '@reputed/shared';

// Hashio's error responses carry no CORS header, so in a browser a throttled read fails outright and
// looks like a dead connection. Reads go to the Mirror Node's call endpoint first: it answers CORS
// properly on success and on revert, and it is what the relay itself calls. Hashio stays as a fallback.

const CALL_URL = `${HEDERA_TESTNET.mirrorNode}/api/v1/contracts/call`;
const CALL_TIMEOUT_MS = 8_000;
const EXECUTION_REVERTED = 3;

interface CallRequest {
  to?: Hex;
  data?: Hex;
  input?: Hex;
  from?: Hex;
}

interface MirrorCallBody {
  result?: Hex;
  _status?: { messages?: { message?: string; data?: Hex }[] };
}

/** The call's result, or undefined when the Mirror Node gave no verdict and another route should try. */
async function mirrorCall(tx: CallRequest): Promise<Hex | undefined> {
  const request = { to: tx.to, data: tx.data ?? tx.input, ...(tx.from ? { from: tx.from } : {}), block: 'latest' };
  let res: Response;
  let body: MirrorCallBody;
  try {
    res = await fetch(CALL_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    body = (await res.json()) as MirrorCallBody;
  } catch {
    return undefined;
  }

  if (res.ok) return body.result;
  const failure = body._status?.messages?.[0];
  if (failure?.message !== 'CONTRACT_REVERT_EXECUTED') return undefined;
  throw new RpcRequestError({
    body: { method: 'eth_call', params: [request] },
    error: { code: EXECUTION_REVERTED, message: 'execution reverted', data: failure.data },
    url: CALL_URL,
  });
}

const relay = http(HEDERA_TESTNET.rpcUrl, { retryCount: 1 })({});

/** For reads the wizard depends on. Writes always go through the wallet. */
export const chainClient = createPublicClient({
  transport: custom(
    {
      async request({ method, params }) {
        if (method === 'eth_call') {
          const result = await mirrorCall((params as [CallRequest])[0]);
          if (result !== undefined) return result;
        }
        return relay.request({ method, params });
      },
    },
    { retryCount: 0 },
  ),
});

export type ChainClient = typeof chainClient;
