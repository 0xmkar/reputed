'use client';

import { useQuery } from '@tanstack/react-query';
import type { AgentDetail } from '@reputed/shared';
import { ApiRequestError, apiGet } from './api';

/** `data` is the agent, `null` when the server answers 404, undefined while loading or on other errors. */
export function useAgent(agentId: string) {
  return useQuery({
    queryKey: ['agent', agentId],
    // Agent IDs are decimal strings; anything else cannot exist, so skip the request.
    enabled: /^\d+$/.test(agentId),
    retry: false,
    queryFn: async ({ signal }): Promise<AgentDetail | null> => {
      try {
        return await apiGet<AgentDetail>(`/api/agents/${agentId}`, signal);
      } catch (err) {
        if (err instanceof ApiRequestError && err.status === 404) return null;
        throw err;
      }
    },
  });
}
