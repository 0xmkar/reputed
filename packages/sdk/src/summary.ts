import type { AgentDetail } from '@reputed/shared';

/** A short, model-friendly view of an agent. Reviews are left out; they can be long. */
export function summarise(agent: AgentDetail) {
  return {
    agentId: agent.agentId,
    name: agent.name,
    description: agent.description,
    score: agent.score.value,
    tier: agent.score.tier,
    // Renamed from `isNew`: the API's name is a UI hint, this one says what the flag means.
    scoreInheritedFromCreator: agent.score.isNew,
    humanBacked: agent.humanBacked,
    status: agent.status,
    creator: agent.creator,
    creatorScore: agent.creatorScore,
    reviewsCounted: agent.reviewsCounted,
    reviewsExcluded: agent.reviewsExcluded,
    penaltiesConfirmed: agent.penaltiesConfirmed,
    scoresStale: agent.scoresStale,
    acceptsX402: agent.acceptsX402,
    credentials: agent.credentials.map((c) => ({ kind: c.kind, title: c.title, revoked: c.revoked })),
  };
}
