import type { ApiError } from '@reputed/shared';

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export class ApiRequestError extends Error {
  constructor(
    public status: number,
    public body: ApiError | null,
  ) {
    super(body?.message ?? `Request failed with status ${status}`);
  }
}

/** GET a JSON endpoint on the Reputed server. Non-2xx responses throw ApiRequestError. */
export async function apiGet<T>(path: string, signal?: AbortSignal, headers?: HeadersInit): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, { signal, headers });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, body);
  }
  return (await res.json()) as T;
}

/** POST JSON to the Reputed server. Non-2xx responses throw ApiRequestError, as does an unreachable server. */
export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError(0, { code: 'INTERNAL_ERROR', message: 'Could not reach the Reputed server. Try again.' });
  }
  if (!res.ok) {
    const error = (await res.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(res.status, error);
  }
  return (await res.json()) as T;
}
