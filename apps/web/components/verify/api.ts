import type { ApiError } from '@reputed/shared';
import { API_URL, ApiRequestError } from '@/lib/api';

// Longer than the server's worst case: World's 10 s, a 60 s receipt wait, then the Mirror Node.
const TIMEOUT_MS = 120_000;

/** POST JSON to the Reputed server. Non-2xx responses throw ApiRequestError. */
export async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, error);
  }
  return (await res.json()) as T;
}
