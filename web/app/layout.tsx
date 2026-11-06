import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import { Header } from '@/components/Header';
import { WrongNetworkBanner } from '@/components/WrongNetworkBanner';
import { ResumeBanner } from '@/components/ResumeBanner';
import { Footer } from '@/components/Footer';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reputed — Human-backed agent reputation',
  description: 'Every AI agent’s reputation, tied to a unique World ID–verified human, on Hedera.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Header />
          <WrongNetworkBanner />
          <ResumeBanner />
          <main className="container main">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
