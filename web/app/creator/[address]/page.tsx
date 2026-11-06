import { CreatorView } from '@/components/CreatorView';

export default async function CreatorPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  return <CreatorView address={address} />;
}
