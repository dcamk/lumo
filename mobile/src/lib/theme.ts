// Dois modos de cor no app móvel. A paleta dá a família de cores (src/theme/palettes.ts);
// o modo decide se a casca é escura ou clara. No claro, o destaque escurece para manter
// contraste com o fundo.
import { mix, type Palette } from '../../../src/theme/palettes';
import { applyPalette } from '../../../src/theme/store';

export type ColorMode = 'escuro' | 'claro';

export const systemMode = (): ColorMode => (window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'claro' : 'escuro');

/** Escreve as variáveis de cor da paleta no modo escolhido */
export function applyTheme(p: Palette, mode: ColorMode) {
  applyPalette(p);
  const root = document.documentElement;
  root.dataset.mode = mode;
  if (mode === 'claro') {
    const c = p.colors;
    const accent = mix(c.accent, '#0b0d10', 0.42);
    const vars: Record<string, string> = {
      '--shell': mix('#f4f5f7', c.accent, 0.04),
      '--surface': '#ffffff',
      '--surface-2': mix('#eef0f3', c.accent, 0.03),
      '--surface-3': mix('#e3e6eb', c.accent, 0.05),
      '--text': '#14171c',
      '--muted': '#5d6572',
      '--accent': accent,
      '--accent-2': mix(c.accent2, '#0b0d10', 0.35),
      '--accent-3': mix(c.accent3, '#0b0d10', 0.45),
      '--on-accent': '#ffffff',
      '--warn': '#a8670f',
      '--danger': '#c0392f',
      '--ok': '#23874f',
      '--line': 'rgba(20, 23, 28, 0.09)',
      '--line-strong': 'rgba(20, 23, 28, 0.18)',
    };
    for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }
  const shell = getComputedStyle(root).getPropertyValue('--shell').trim();
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', shell || p.colors.shell);
}
