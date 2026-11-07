'use client';

import { usePathname } from 'next/navigation';
import { Nav } from './Nav';

/** The navy top panel with the nav. The landing page draws the same nav inside its hero instead. */
export function Header() {
  const pathname = usePathname();
  if (pathname === '/') return null;
  return (
    <header className="topbar container">
      <div className="topbar-panel">
        <Nav />
      </div>
    </header>
  );
}
