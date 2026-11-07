import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Providers } from '@/components/Providers';
import { Header } from '@/components/Header';
import { WrongNetworkBanner } from '@/components/WrongNetworkBanner';
import { WalletAccountBanner } from '@/components/WalletAccountBanner';
import { Footer } from '@/components/Footer';
import { SiteBackground } from '@/components/SiteBackground';
import './globals.css';

export const metadata: Metadata = {
  title: 'Reputed — Human-backed agent reputation',
  description: 'Every AI agent’s reputation, tied to a unique World ID–verified human, on Hedera.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,500;12..96,600&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&display=swap"
        />
      </head>
      <body>
        <SiteBackground />
        <Providers>
          <Header />
          <WrongNetworkBanner />
          <WalletAccountBanner />
          <main className="container main">{children}</main>
          <Footer />
        </Providers>
      </body>
    </html>
  );
}
