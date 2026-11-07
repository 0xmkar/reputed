import { AgentView } from '@/components/AgentView';

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return <AgentView agentId={agentId} />;
}
