// Fonte única de tamanho do Lumo. O slider "Tamanho" (lumoScale) define o personagem
// nos dois modos; o painel ainda pode ser esticado pelo canto (panelExtra).
//
// A janela nativa é um overlay de tamanho FIXO (o maior estado). Dentro dela, a
// "casca" preta (pílula/painel/tela de soltar arquivo) muda de tamanho animada — sem
// redimensionar a janela, o WebKitGTK não deixa rastros nem "pula".
import type { WindowMode } from '../types';

export const SCALE_MIN = 0.8;
export const SCALE_MAX = 1.6;

export const clampScale = (k: number) => Math.min(SCALE_MAX, Math.max(SCALE_MIN, Number.isFinite(k) ? k : 1));

export interface PanelExtra {
  w: number;
  h: number;
}

/** Quanto o painel pode crescer além do tamanho base (puxando o canto) */
export const PANEL_EXTRA_MAX: PanelExtra = { w: 320, h: 260 };

export const clampExtra = (e?: Partial<PanelExtra>): PanelExtra => ({
  w: Math.round(Math.min(PANEL_EXTRA_MAX.w, Math.max(0, e?.w ?? 0))),
  h: Math.round(Math.min(PANEL_EXTRA_MAX.h, Math.max(0, e?.h ?? 0))),
});

/** Modo compacto (pílula no topo). 100% = blob de 60 px, legível. */
export function compactLayout(k: number) {
  const char = Math.round(60 * clampScale(k));
  return { char, width: Math.max(168, Math.round(char * 2.8)), height: char + 8 };
}

/** Largura da pílula compacta quando mostra um aviso (ex.: e-mail novo) */
export const COMPACT_NOTICE_WIDTH = 440;

/** Tela "solte o arquivo aqui" */
export const DROP_SIZE = { width: 520, height: 150 };

/** Painel expandido: coluna esquerda (pílulas 2×3 + Lumo) e conteúdo à direita */
export const PILLS_WIDTH = 148;
export const PILLS_HEIGHT = 130; // 4 linhas de pílulas (h-7) + espaços (gap-1.5)
const PANEL_PADDING = 12;

export function quickLayout(k: number, extra: PanelExtra = { w: 0, h: 0 }) {
  const char = Math.round(100 * clampScale(k));
  const side = Math.max(PILLS_WIDTH, char + 4);
  const height = Math.max(280, PANEL_PADDING * 2 + PILLS_HEIGHT + 12 + char) + extra.h;
  return { char, side, width: 580 + (side - PILLS_WIDTH) + extra.w, height };
}

/** Tamanho da casca preta em cada modo */
export function shellSize(mode: WindowMode, k: number, extra: PanelExtra, wide: boolean) {
  if (mode === 'quick') {
    const q = quickLayout(k, extra);
    return { width: q.width, height: q.height };
  }
  if (mode === 'drop') return DROP_SIZE;
  const c = compactLayout(k);
  return { width: wide ? COMPACT_NOTICE_WIDTH : c.width, height: c.height };
}

/** Janela nativa: cabe qualquer estado (folga para a mola da animação passar do ponto) */
export function overlaySize(k: number, extra: PanelExtra) {
  const q = quickLayout(k, extra);
  return {
    width: Math.max(q.width, COMPACT_NOTICE_WIDTH, DROP_SIZE.width) + 24,
    height: Math.max(q.height, DROP_SIZE.height) + 16,
  };
}
