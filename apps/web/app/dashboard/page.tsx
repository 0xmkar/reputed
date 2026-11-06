import type { Metadata } from 'next';
import { DashboardGate } from '@/components/dashboard/DashboardGate';

export const metadata: Metadata = {
  title: 'Dashboard — Reputed',
  description: 'Create API keys that let your Hedera agents register themselves and get a reputation.',
};

export default function DashboardPage() {
  return <DashboardGate />;
}
