'use client';

import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { AgentListResponse, AgentQuery } from '@reputed/shared';
import { apiGet } from './api';

/** Builds the query string for GET /api/agents from an AgentQuery. */
export function agentsPath(query: AgentQuery): string {
  const params = new URLSearchParams();
  if (query.q) params.set('q', query.q);
  if (query.humanBacked !== undefined) params.set('humanBacked', String(query.humanBacked));
  if (query.minScore) params.set('minScore', String(query.minScore));
  const qs = params.toString();
  return `/api/agents${qs ? `?${qs}` : ''}`;
}

export function useAgents(query: AgentQuery) {
  return useQuery({
    queryKey: ['agents', query],
    queryFn: ({ signal }) => apiGet<AgentListResponse>(agentsPath(query), signal),
    // Keep showing the previous results while a changed filter loads.
    placeholderData: keepPreviousData,
  });
}
