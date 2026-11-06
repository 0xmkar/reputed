import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import type { AgentEndpoints } from '@reputed/shared';

const MAX_AGENT_FILE_BYTES = 256 * 1024;
const FETCH_TIMEOUT_MS = 8_000;

const PRIVATE_RANGES = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.168.0.0', 16],
] as const) {
  PRIVATE_RANGES.addSubnet(network, prefix, 'ipv4');
}
PRIVATE_RANGES.addAddress('::1', 'ipv6');
PRIVATE_RANGES.addSubnet('fc00::', 7, 'ipv6');
PRIVATE_RANGES.addSubnet('fe80::', 10, 'ipv6');

export interface AgentProfile {
  name?: string;
  description?: string;
  image?: string;
  tags: string[];
  endpoints: AgentEndpoints;
}

/** A browser resolves these the same way, so a leading space cannot smuggle a javascript: URL. */
function hasScheme(value: string, schemes: readonly string[]): boolean {
  return URL.canParse(value) && schemes.includes(new URL(value).protocol);
}

const LINK_SCHEMES = ['http:', 'https:'];
// ipfs: cannot run anything in a browser, and agent files are hosted there.
const IMAGE_SCHEMES = [...LINK_SCHEMES, 'ipfs:'];

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

export function parseAgentProfile(body: string | null): AgentProfile {
  const empty: AgentProfile = { tags: [], endpoints: {} };
  if (body === null) return empty;
  let file: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(body);
    if (!parsed || typeof parsed !== 'object') return empty;
    file = parsed as Record<string, unknown>;
  } catch {
    return empty;
  }

  const endpoints: AgentEndpoints = {};
  const services = Array.isArray(file['services']) ? file['services'] : [];
  for (const service of services as { name?: unknown; endpoint?: unknown }[]) {
    if (typeof service?.endpoint !== 'string' || typeof service?.name !== 'string') continue;
    if (!hasScheme(service.endpoint, LINK_SCHEMES)) continue;
    const name = service.name.toLowerCase();
    if (name === 'a2a') endpoints.a2a = service.endpoint;
    else if (name === 'mcp') endpoints.mcp = service.endpoint;
    else if (name === 'web') endpoints.web = service.endpoint;
  }
  if (typeof file['x402PriceHbar'] === 'number') endpoints.x402PriceHbar = file['x402PriceHbar'];

  const text = (key: string) => (typeof file[key] === 'string' ? file[key] : undefined);
  const name = text('name');
  const description = text('description');
  const rawImage = text('image');
  const image = rawImage && hasScheme(rawImage, IMAGE_SCHEMES) ? rawImage : undefined;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(image ? { image } : {}),
    tags: stringList(file['tags']),
    endpoints,
  };
}

function decodeDataUri(uri: string): string | null {
  const comma = uri.indexOf(',');
  if (comma < 0) return null;
  const payload = uri.slice(comma + 1);
  try {
    return uri.slice(0, comma).endsWith(';base64')
      ? Buffer.from(payload, 'base64').toString('utf8')
      : decodeURIComponent(payload);
  } catch {
    return null;
  }
}

async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [{ address: host, family: isIP(host) }]
    : await lookup(host, { all: true });
  for (const { address, family } of addresses) {
    if (PRIVATE_RANGES.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      throw new Error('agent file host is not public');
    }
  }
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_AGENT_FILE_BYTES) {
      await reader.cancel();
      throw new Error('agent file is too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Agent URIs are chosen by whoever registered the agent, so the server treats them as hostile:
 * public hosts only, no redirects, capped size. Returns null for anything it cannot read.
 */
export async function loadAgentFile(
  uri: string,
  options: { ipfsGateway: string; fetch?: typeof fetch },
): Promise<string | null> {
  if (uri.startsWith('data:')) return decodeDataUri(uri);

  const url = uri.startsWith('ipfs://')
    ? `${options.ipfsGateway.replace(/\/$/, '')}/${uri.slice('ipfs://'.length)}`
    : uri;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return null;
    await assertPublicHost(parsed.hostname);
    const response = await (options.fetch ?? fetch)(parsed, {
      redirect: 'error',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    return response.ok ? await readCapped(response) : null;
  } catch {
    return null;
  }
}
