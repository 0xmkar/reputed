import { hashscan } from '@reputed/shared';

const HCS_URI = /^hcs:\/\/(\d+\.\d+\.\d+)\/(\d+)$/;

/**
 * Where to send someone who wants to read a file the chain points at:
 * an http(s) URL as is, an hcs://<topicId>/<sequence> URI as its HashScan topic page,
 * anything else (for example ipfs://) has no link.
 */
export function fileHref(uri: string | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('https://') || uri.startsWith('http://')) return uri;
  const hcs = HCS_URI.exec(uri);
  return hcs?.[1] ? hashscan.topic(hcs[1]) : null;
}
