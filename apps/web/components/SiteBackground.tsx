'use client';

import { useEffect, useRef } from 'react';

const PULSE_MS = 700;
const RING_MS = 600;

/**
 * The page background: the hero's navy gradient and ribbed glass behind every page,
 * with the coral glow easing toward the pointer and pulsing on click.
 * Touch screens and reduced-motion keep it centred and still.
 */
export function SiteBackground() {
  const glow = useRef<HTMLDivElement>(null);
  const rings = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = glow.current;
    const ringLayer = rings.current;
    if (!el || !ringLayer) return;
    if (matchMedia('(prefers-reduced-motion: reduce)').matches || !matchMedia('(pointer: fine)').matches) return;

    let targetX = innerWidth / 2;
    let targetY = innerHeight * 0.55;
    let x = targetX;
    let y = targetY;
    let frame = 0;
    let pulseTimer = 0;

    const tick = () => {
      x += (targetX - x) * 0.07;
      y += (targetY - y) * 0.07;
      el.style.setProperty('--glow-x', `${x}px`);
      el.style.setProperty('--glow-y', `${y}px`);
      // The loop stops once the glow has settled; the next mouse move starts it again.
      frame = Math.abs(targetX - x) > 0.3 || Math.abs(targetY - y) > 0.3 ? requestAnimationFrame(tick) : 0;
    };
    const onMove = (e: MouseEvent) => {
      targetX = e.clientX;
      targetY = e.clientY;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.pointerType !== 'mouse') return;
      // The glow swells once from where it is; a thin ring marks the exact click.
      el.classList.remove('is-pulse');
      void el.offsetWidth; // Forces a reflow so re-adding the class restarts the animation.
      el.classList.add('is-pulse');
      clearTimeout(pulseTimer);
      pulseTimer = window.setTimeout(() => el.classList.remove('is-pulse'), PULSE_MS);

      const ring = document.createElement('span');
      ring.className = 'click-ring';
      ring.style.left = `${e.clientX}px`;
      ring.style.top = `${e.clientY}px`;
      ringLayer.append(ring);
      window.setTimeout(() => ring.remove(), RING_MS);
    };

    addEventListener('mousemove', onMove, { passive: true });
    addEventListener('pointerdown', onDown, { passive: true });
    return () => {
      removeEventListener('mousemove', onMove);
      removeEventListener('pointerdown', onDown);
      cancelAnimationFrame(frame);
      clearTimeout(pulseTimer);
    };
  }, []);

  return (
    <>
      <div className="site-bg" aria-hidden="true" />
      <div ref={glow} className="site-glow" aria-hidden="true" />
      <div className="site-ribs" aria-hidden="true" />
      <div ref={rings} className="site-rings" aria-hidden="true" />
    </>
  );
}
