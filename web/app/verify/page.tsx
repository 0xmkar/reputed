import type { Metadata } from 'next';
import { VerifyScreen } from '@/components/verify/VerifyScreen';

export const metadata: Metadata = { title: 'Verify — Reputed' };

export default function VerifyPage() {
  return <VerifyScreen />;
}
