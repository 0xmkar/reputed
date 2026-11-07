import { redirect } from 'next/navigation';

// Agents register from the SDK now, with an API key from the dashboard. Old links still land somewhere useful.
export default function OnboardPage() {
  redirect('/dashboard');
}
