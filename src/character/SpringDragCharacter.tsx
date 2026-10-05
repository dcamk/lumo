import React, { useCallback, useEffect, useRef } from 'react';

// ---------------------------------------------------------------------------
// Torna o personagem arrastável SOMENTE dentro de `boundsRef` (a área do painel).
// Ao soltar, uma mola amortecida o devolve à posição de repouso.
// O transform é aplicado direto no DOM (sem re-render do React durante o arrasto).
// ---------------------------------------------------------------------------

export interface DragEndInfo {
  /** Quantas vezes o arrasto inverteu de direção com velocidade (chacoalhada) */
  shakes: number;
  /** Soltou com o cursor fora da janela do Lumo (ex.: sobre outra janela) */
  outside: boolean;
}

interface SpringDragProps {
  boundsRef: React.RefObject<HTMLElement | null>;
  children: React.ReactNode;
  className?: string;
  onDragStart?: () => void;
  onDragEnd?: (info: DragEndInfo) => void;
}

const SPRING_K = 190; // rigidez
const SPRING_C = 15; // amortecimento (ζ ≈ 0.54 → rebote visível)
const DRAG_THRESHOLD = 5; // px antes de considerar arrasto (abaixo disso é clique)

export const SpringDragCharacter: React.FC<SpringDragProps> = ({
  boundsRef,
  children,
  className = '',
  onDragStart,
  onDragEnd,
}) => {
  const elRef = useRef<HTMLDivElement | null>(null);
  const cbRef = useRef({ onDragStart, onDragEnd });
  cbRef.current = { onDragStart, onDragEnd };
  const detachRef = useRef<() => void>(() => {});
  const st = useRef({
    x: 0, y: 0, vx: 0, vy: 0,
    minX: -Infinity, maxX: Infinity, minY: -Infinity, maxY: Infinity,
    px0: 0, py0: 0, x0: 0, y0: 0,
    dragging: false, moved: false,
    raf: 0, last: 0, lastMove: 0,
    lastDir: 0, shakes: 0,
  });

  const apply = useCallback(() => {
    const el = elRef.current;
    if (!el) return;
    const s = st.current;
    const tilt = Math.max(-14, Math.min(14, s.vx * 0.025)); // inclina na direção do movimento
    el.style.transform = `translate3d(${s.x.toFixed(2)}px, ${s.y.toFixed(2)}px, 0) rotate(${tilt.toFixed(2)}deg)`;
  }, []);

  const tick = useCallback(
    (t: number) => {
      const s = st.current;
      const dt = Math.min((t - s.last) / 1000, 1 / 30);
      s.last = t;

      if (s.dragging) {
        s.vx *= Math.exp(-8 * dt); // a inclinação relaxa se o mouse parar
        s.vy *= Math.exp(-8 * dt);
      } else {
        s.vx += (-SPRING_K * s.x - SPRING_C * s.vx) * dt;
        s.vy += (-SPRING_K * s.y - SPRING_C * s.vy) * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;

        // O overshoot nunca sai da área: encosta na borda e perde energia
        if (s.x < s.minX) { s.x = s.minX; s.vx *= -0.3; }
        else if (s.x > s.maxX) { s.x = s.maxX; s.vx *= -0.3; }
        if (s.y < s.minY) { s.y = s.minY; s.vy *= -0.3; }
        else if (s.y > s.maxY) { s.y = s.maxY; s.vy *= -0.3; }

        if (Math.abs(s.x) < 0.05 && Math.abs(s.y) < 0.05 && Math.abs(s.vx) < 0.5 && Math.abs(s.vy) < 0.5) {
          s.x = s.y = s.vx = s.vy = 0;
          apply();
          s.raf = 0;
          return;
        }
      }
      apply();
      s.raf = requestAnimationFrame(tick);
    },
    [apply]
  );

  useEffect(
    () => () => {
      cancelAnimationFrame(st.current.raf);
      detachRef.current();
    },
    []
  );

  const handlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const el = elRef.current;
    const box = boundsRef.current;
    if (!el || !box) return;
    e.stopPropagation(); // não deixa a drag-region da janela assumir

    const s = st.current;
    detachRef.current();

    // Limites: o retângulo do personagem precisa ficar dentro da área
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    s.minX = s.x + (b.left - r.left);
    s.maxX = s.x + (b.right - r.right);
    s.minY = s.y + (b.top - r.top);
    s.maxY = s.y + (b.bottom - r.bottom);

    s.px0 = e.clientX; s.py0 = e.clientY;
    s.x0 = s.x; s.y0 = s.y;
    s.vx = 0; s.vy = 0;
    s.moved = false;
    s.dragging = true;
    s.lastDir = 0; s.shakes = 0;
    s.last = s.lastMove = performance.now();
    if (!s.raf) s.raf = requestAnimationFrame(tick);

    const move = (ev: PointerEvent) => {
      const dx = ev.clientX - s.px0;
      const dy = ev.clientY - s.py0;
      if (!s.moved) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
        s.moved = true;
        cbRef.current.onDragStart?.();
      }
      const nx = Math.min(s.maxX, Math.max(s.minX, s.x0 + dx));
      const ny = Math.min(s.maxY, Math.max(s.minY, s.y0 + dy));
      const now = performance.now();
      const dtm = Math.max(1, now - s.lastMove);
      const instVx = ((nx - s.x) / dtm) * 1000;
      s.vx = s.vx * 0.7 + instVx * 0.3;
      s.vy = s.vy * 0.7 + ((ny - s.y) / dtm) * 1000 * 0.3;

      // Conta inversões rápidas de direção (chacoalhar)
      if (Math.abs(instVx) > 250) {
        const dir = Math.sign(instVx);
        if (s.lastDir !== 0 && dir !== s.lastDir) s.shakes++;
        s.lastDir = dir;
      }

      s.x = nx; s.y = ny;
      s.lastMove = now;
    };

    const up = (ev: PointerEvent) => {
      detachRef.current();
      const outside =
        ev.clientX < 0 || ev.clientY < 0 || ev.clientX > window.innerWidth || ev.clientY > window.innerHeight;
      s.dragging = false;
      s.vx = 0; s.vy = 0; // volta só pela mola, sem herdar a velocidade do arrasto
      s.last = performance.now();
      if (!s.raf) s.raf = requestAnimationFrame(tick);
      if (s.moved) cbRef.current.onDragEnd?.({ shakes: s.shakes, outside });
    };

    detachRef.current = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      detachRef.current = () => {};
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };

  return (
    <div
      ref={elRef}
      onPointerDown={handlePointerDown}
      // Depois de um arrasto, o click que o navegador dispara não pode virar "squash + pop"
      onClickCapture={(e) => {
        if (st.current.moved) {
          e.stopPropagation();
          e.preventDefault();
        }
      }}
      className={`relative z-30 select-none cursor-grab active:cursor-grabbing ${className}`}
      style={{ touchAction: 'none', willChange: 'transform' }}
    >
      {children}
    </div>
  );
};
