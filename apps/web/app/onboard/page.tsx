import type { Metadata } from 'next';
import { OnboardGate } from '@/components/onboard/OnboardGate';

export const metadata: Metadata = {
  title: 'Onboard agent — Reputed',
  description: 'Register an agent, link it to your verified creator identity and receive its Human-backed credential.',
};

export default function OnboardPage() {
  return <OnboardGate />;
}
