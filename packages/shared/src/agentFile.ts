import type { AgentFileRequest } from './api';

export const MAX_NAME = 50;
export const MAX_DESCRIPTION = 280;
export const MAX_TAGS = 8;
export const MAX_TAG_LENGTH = 24;
/** MAX_AGENT_URI_BYTES in server/src/routes/agentFile.ts. */
export const MAX_AGENT_URI_BYTES = 5_000;

const DATA_URI_PREFIX = 'data:application/json;base64,';

export interface AgentFields {
  name: string;
  description: string;
  image: string;
  tags: string[];
  a2a: string;
  mcp: string;
  web: string;
  x402: boolean;
  /** As typed, in HBAR. */
  x402Price: string;
}

export const EMPTY_FIELDS: AgentFields = {
  name: '',
  description: '',
  image: '',
  tags: [],
  a2a: '',
  mcp: '',
  web: '',
  x402: false,
  x402Price: '',
};

function hasScheme(value: string, schemes: string[]): boolean {
  return URL.canParse(value) && schemes.includes(new URL(value).protocol);
}

/** The indexer drops endpoints that are not http(s), so the form refuses them too. */
export const isLinkUrl = (value: string) => hasScheme(value.trim(), ['http:', 'https:']);
export const isImageUrl = (value: string) => hasScheme(value.trim(), ['http:', 'https:', 'ipfs:']);

/** Tinybar is the smallest unit, so at most 8 decimal places. */
export function isValidPrice(value: string): boolean {
  return /^\d+(\.\d{1,8})?$/.test(value.trim()) && Number(value) > 0;
}

export function detailsComplete(fields: AgentFields): boolean {
  return fields.name.trim().length > 0 && (!fields.image.trim() || isImageUrl(fields.image));
}

export function endpointsComplete(fields: AgentFields): boolean {
  const urls = [fields.a2a, fields.mcp, fields.web].map((url) => url.trim()).filter(Boolean);
  return urls.length > 0 && urls.every(isLinkUrl) && (!fields.x402 || isValidPrice(fields.x402Price));
}

/** Names follow ERC-8004. The indexer reads `a2a`, `mcp` and `web` in any case. */
export function buildAgentFile(fields: AgentFields): AgentFileRequest {
  const services = [
    { name: 'A2A', endpoint: fields.a2a.trim() },
    { name: 'MCP', endpoint: fields.mcp.trim() },
    { name: 'web', endpoint: fields.web.trim() },
  ].filter((service) => service.endpoint);

  return {
    type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1',
    name: fields.name.trim(),
    description: fields.description.trim(),
    image: fields.image.trim(),
    services,
    x402Support: fields.x402,
    active: true,
    // The agent ID does not exist until the file is registered, and the URI cannot change afterwards.
    registrations: [],
    supportedTrust: ['reputation'],
    tags: fields.tags,
    ...(fields.x402 ? { x402PriceHbar: Number(fields.x402Price) } : {}),
  };
}

/** The length of the data URI the server will build for this file. */
export function agentUriBytes(file: AgentFileRequest): number {
  const json = new TextEncoder().encode(JSON.stringify(file)).length;
  return DATA_URI_PREFIX.length + Math.ceil(json / 3) * 4;
}
