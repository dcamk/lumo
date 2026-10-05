// Paleta ativa: uma só fonte da verdade, lida pelo React (usePalette), pelo canvas do
// personagem (getPalette a cada quadro) e pelo CSS (variáveis em :root).
import { useSyncExternalStore } from 'react';
import { DEFAULT_PALETTE, isPaletteId, mix, PALETTES, type Palette, type PaletteId } from './palettes';

function savedId(): PaletteId {
  try {
    const raw = JSON.parse(localStorage.getItem('lumo.settings') ?? '{}') as { palette?: unknown };
    if (isPaletteId(raw.palette)) return raw.palette;
  } catch {
    /* sem configuração salva */
  }
  return DEFAULT_PALETTE;
}

let current: Palette = PALETTES[savedId()];
const subs = new Set<() => void>();

/** Escreve as cores da paleta como variáveis CSS (index.css só usa as variáveis) */
export function applyPalette(p: Palette) {
  const root = document.documentElement;
  const c = p.colors;
  const vars: Record<string, string> = {
    '--shell': c.shell,
    '--surface': c.surface,
    '--surface-2': c.surface2,
    '--surface-3': c.surface3,
    '--text': c.text,
    '--muted': c.muted,
    '--accent': c.accent,
    '--accent-2': c.accent2,
    '--accent-3': c.accent3,
    '--on-accent': c.onAccent,
    '--warn': c.warn,
    '--danger': c.danger,
    '--ok': c.ok,
    '--line': mix(c.shell, c.text, 0.14),
    '--line-strong': mix(c.shell, c.text, 0.28),
    '--mood': c.accent,
    '--speed': String(p.motion.speed),
  };
  for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  root.dataset.palette = p.id;
  root.dataset.font = p.font;
}

export const getPalette = () => current;

export function setPalette(id: PaletteId) {
  if (current.id === id) return;
  current = PALETTES[id];
  applyPalette(current);
  subs.forEach((fn) => fn());
}

const subscribe = (fn: () => void) => {
  subs.add(fn);
  return () => void subs.delete(fn);
};

export const usePalette = () => useSyncExternalStore(subscribe, getPalette);

// Visual do corpo (clássico × realista): independe da paleta, vale para todas
export type Look = 'classico' | 'realista';
export const isLook = (v: unknown): v is Look => v === 'classico' || v === 'realista';

let look: Look = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem('lumo.settings') ?? '{}') as { look?: unknown };
    if (isLook(raw.look)) return raw.look;
  } catch {
    /* sem configuração salva */
  }
  return 'classico';
})();
const lookSubs = new Set<() => void>();

export const getLook = () => look;

export function setLook(next: Look) {
  if (look === next) return;
  look = next;
  lookSubs.forEach((fn) => fn());
}

const subscribeLook = (fn: () => void) => {
  lookSubs.add(fn);
  return () => void lookSubs.delete(fn);
};

export const useLook = () => useSyncExternalStore(subscribeLook, getLook);

// Já na carga: as cores certas antes do primeiro quadro (sem piscar a paleta padrão)
if (typeof document !== 'undefined') applyPalette(current);
