// Movimento do usuário num só lugar: rolagem, arraste e inclinação do aparelho viram uma
// "velocidade" que as partículas (fundo e 3D) leem a cada quadro. Assim elas andam junto
// com o que a pessoa faz, e voltam a flutuar devagar quando tudo para.

export const motion = {
  /** Velocidade vertical (px/quadro, já suavizada): rolar para baixo = positiva */
  vy: 0,
  /** Velocidade horizontal (arraste/toque) */
  vx: 0,
  /** Inclinação do aparelho, −1…1 */
  tiltX: 0,
  tiltY: 0,
};

let started = false;
const lastTop = new WeakMap<EventTarget, number>();

/** Liga os ouvintes globais (uma vez) */
export function startMotionBus() {
  if (started) return;
  started = true;

  // Captura: pega a rolagem de qualquer lista da tela
  document.addEventListener(
    'scroll',
    (e) => {
      const el = e.target as Element | Document;
      const top = el instanceof Document ? window.scrollY : (el as Element).scrollTop;
      const prev = lastTop.get(el) ?? top;
      lastTop.set(el, top);
      const d = Math.max(-80, Math.min(80, top - prev));
      motion.vy += d * 0.35;
    },
    { capture: true, passive: true }
  );

  let px = 0;
  let py = 0;
  let down = false;
  window.addEventListener('pointerdown', (e) => {
    down = true;
    px = e.clientX;
    py = e.clientY;
  });
  window.addEventListener('pointerup', () => (down = false));
  window.addEventListener('pointercancel', () => (down = false));
  window.addEventListener(
    'pointermove',
    (e) => {
      if (!down) return;
      motion.vx += Math.max(-40, Math.min(40, e.clientX - px)) * 0.12;
      motion.vy -= Math.max(-40, Math.min(40, e.clientY - py)) * 0.06;
      px = e.clientX;
      py = e.clientY;
    },
    { passive: true }
  );

  window.addEventListener('deviceorientation', (e) => {
    if (e.gamma == null || e.beta == null) return;
    motion.tiltX = Math.max(-1, Math.min(1, e.gamma / 35));
    motion.tiltY = Math.max(-1, Math.min(1, (e.beta - 45) / 35));
  });

  // Amortece a velocidade (um laço só, para todos que leem)
  let last = performance.now();
  const tick = (now: number) => {
    const k = Math.exp(-Math.min(0.1, (now - last) / 1000) * 3.2);
    last = now;
    motion.vy *= k;
    motion.vx *= k;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
