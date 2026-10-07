// Poeira de luz no fundo do app. Cada partícula tem uma profundidade: as de perto andam
// mais quando a pessoa rola a tela, arrasta ou inclina o aparelho (paralaxe), e todas
// voltam a subir devagar quando o movimento para.
import { useEffect, useRef } from 'react';
import { motion } from '../lib/motionBus';

interface Dot {
  x: number;
  y: number;
  z: number; // 0.2 (longe) … 1 (perto)
  r: number;
  phase: number;
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

export function ParticleField() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let w = 0;
    let h = 0;
    let dpr = 1;
    let dots: Dot[] = [];
    let color = '200, 210, 225';

    const readColor = () => {
      const v = getComputedStyle(document.documentElement).getPropertyValue('--accent-3').trim();
      const m = v.match(/^#([0-9a-f]{6})$/i);
      if (m) {
        const n = parseInt(m[1], 16);
        color = `${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}`;
      }
    };

    const resize = () => {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // Densidade parecida em celular e tablet
      const count = Math.round(Math.min(110, (w * h) / 9000));
      dots = Array.from({ length: count }, () => {
        const z = 0.2 + Math.random() * 0.8;
        return { x: Math.random() * w, y: Math.random() * h, z, r: 0.5 + z * 1.3, phase: Math.random() * Math.PI * 2 };
      });
    };
    resize();
    readColor();
    window.addEventListener('resize', resize);
    // Troca de paleta ou de modo claro/escuro
    const obs = new MutationObserver(readColor);
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['style', 'data-mode'] });

    const still = reduced();
    let raf = 0;
    let last = performance.now();
    let t = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      t += dt;
      ctx.clearRect(0, 0, w, h);
      const light = document.documentElement.dataset.mode === 'claro';
      for (const d of dots) {
        if (!still) {
          // Deriva lenta para cima + o movimento do usuário, proporcional à profundidade
          d.y += (-6 * d.z - motion.vy * d.z * 0.9) * dt * 6;
          d.x += (Math.sin(t * 0.3 + d.phase) * 2 * d.z + motion.vx * d.z * 0.8 + motion.tiltX * d.z * 6) * dt * 6;
          if (d.y < -4) d.y += h + 8;
          if (d.y > h + 4) d.y -= h + 8;
          if (d.x < -4) d.x += w + 8;
          if (d.x > w + 4) d.x -= w + 8;
        }
        const twinkle = 0.55 + Math.sin(t * 0.8 + d.phase) * 0.45;
        const alpha = (light ? 0.22 : 0.35) * d.z * twinkle;
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color}, ${alpha.toFixed(3)})`;
        ctx.arc(d.x + motion.tiltX * d.z * 10, d.y + motion.tiltY * d.z * 10, d.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    const onVis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      obs.disconnect();
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  return <canvas ref={ref} className="pointer-events-none fixed inset-0 z-0" aria-hidden />;
}
