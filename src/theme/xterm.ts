// Cores do terminal (xterm.js) a partir da paleta ativa
import type { ITheme } from '@xterm/xterm';
import { mix, type Palette } from './palettes';

export function xtermTheme(p: Palette): ITheme {
  const c = p.colors;
  const base = { background: 'rgba(0,0,0,0)', cursorAccent: c.shell, selectionBackground: `${c.accent}55` };
  if (p.id === 'matrix') {
    return {
      ...base,
      foreground: c.text,
      cursor: c.accent,
      black: '#02130a', red: '#ff3b5c', green: '#00ff66', yellow: '#d8ff3c',
      blue: '#00c2a8', magenta: '#7dffb0', cyan: '#3cffe0', white: c.text,
      brightBlack: '#2f6b46', brightRed: '#ff6b84', brightGreen: '#7dffb0', brightYellow: '#ecff8a',
      brightBlue: '#3cffe0', brightMagenta: '#b6ffd2', brightCyan: '#9affee', brightWhite: '#ffffff',
    };
  }
  const bright = (x: string) => mix(x, '#ffffff', 0.28);
  return {
    ...base,
    foreground: c.text,
    cursor: c.accent,
    black: mix(c.shell, c.text, 0.12),
    red: c.danger,
    green: c.ok,
    yellow: c.warn,
    blue: c.accent,
    magenta: mix(c.accent2, c.danger, 0.35),
    cyan: c.accent3,
    white: c.text,
    brightBlack: c.muted,
    brightRed: bright(c.danger),
    brightGreen: bright(c.ok),
    brightYellow: bright(c.warn),
    brightBlue: bright(c.accent),
    brightMagenta: bright(mix(c.accent2, c.danger, 0.35)),
    brightCyan: bright(c.accent3),
    brightWhite: '#ffffff',
  };
}
