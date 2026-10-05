// Paletas do Lumo. Cada paleta é também uma PERSONALIDADE: muda as cores, o desenho do
// personagem, o jeito de se mover (motion-art-direction: uma "linguagem de movimento"
// por vez), o timbre dos sons e o tom da conversa com a IA.
// Quanto mais escura a paleta, mais "dark hacker" o Lumo fica.
import type { CharacterEmotion } from '../character/types';

export type PaletteId = 'grafite' | 'safira' | 'indigo' | 'ambar' | 'noir' | 'matrix';

export type VoiceStyle = 'discreto' | 'terminal' | 'criatura';
export type ParticleStyle = 'ticks' | 'glyphs';

export interface PaletteColors {
  /** Fundo da casca (pílula / painel) */
  shell: string;
  /** Cartões, campos e linhas de lista */
  surface: string;
  surface2: string;
  surface3: string;
  text: string;
  muted: string;
  accent: string;
  accent2: string;
  accent3: string;
  /** Texto sobre fundo de destaque */
  onAccent: string;
  warn: string;
  danger: string;
  ok: string;
  /** Corpo do Lumo */
  bodyTop: string;
  bodyBottom: string;
  bodyEdge: string;
  eye: string;
}

export interface MotionProfile {
  /** Nome da personalidade de movimento (motion-art-direction) */
  name: string;
  /** Multiplicador das durações (1 = base) */
  speed: number;
  /** Mola da interface (anime.js): 0 = sem sobrepasso */
  bounce: number;
  /** Quanto o corpo amassa/estica (1 = antigo, desenho animado; 0 = rígido) */
  squash: number;
  /** Altura dos pulos e balanços */
  lift: number;
  /** Amortecimento da mola do corpo (ζ): <1 balança, 1 = sem sobrepasso */
  damping: number;
  /** 0–1: glitch digital (fatias deslocadas, tremor) */
  glitch: number;
  /** Peso de cada comportamento espontâneo (10 s parado) */
  idle: Partial<Record<'wander' | 'lookAround' | 'hop' | 'stretch' | 'wiggle' | 'wink' | 'yawn' | 'glitch', number>>;
}

export interface Palette {
  id: PaletteId;
  name: string;
  tagline: string;
  /** Posição na escala claro → escuro (1 = mais clara) */
  darkness: number;
  /** Traços 0–1 mostrados no painel de estilo */
  traits: { formal: number; energia: number; ousadia: number };
  colors: PaletteColors;
  /** Desenho do personagem */
  character: {
    /** Raio dos cantos (fração do lado) */
    corner: number;
    /** Brilho dos olhos (0 = apagados, 1 = LED forte) */
    eyeGlow: number;
    /** Linhas de varredura no corpo */
    scanlines: boolean;
    particles: ParticleStyle;
  };
  motion: MotionProfile;
  voice: VoiceStyle;
  /** Fonte da interface */
  font: 'sans' | 'mono';
  /** Acrescentado ao prompt da IA: muda o jeito de responder */
  persona: string;
  /** Descrição curta do jeito do Lumo nesta paleta */
  vibe: string;
}

const NO_EMOJI = 'Nunca use emojis.';

export const PALETTES: Record<PaletteId, Palette> = {
  grafite: {
    id: 'grafite',
    name: 'Grafite',
    tagline: 'Executivo',
    darkness: 1,
    traits: { formal: 0.9, energia: 0.3, ousadia: 0.1 },
    colors: {
      shell: '#0d0f13', surface: '#13161b', surface2: '#0a0c0f', surface3: '#1a1e25',
      text: '#e8ecf2', muted: '#8a94a3',
      accent: '#8fa6c4', accent2: '#6a86ad', accent3: '#b7c4d6', onAccent: '#0b1018',
      warn: '#e0a84a', danger: '#e5645f', ok: '#6fcf97',
      bodyTop: '#d5dbe4', bodyBottom: '#98a2b0', bodyEdge: 'rgba(255,255,255,0.55)', eye: '#0f141b',
    },
    character: { corner: 0.3, eyeGlow: 0, scanlines: false, particles: 'ticks' },
    motion: {
      name: 'Corporate', speed: 1, bounce: 0.04, squash: 0.32, lift: 0.3, damping: 0.88, glitch: 0,
      idle: { wander: 3, lookAround: 4, hop: 0.2, stretch: 1, wiggle: 0, wink: 0.3, yawn: 1 },
    },
    voice: 'discreto',
    font: 'sans',
    persona: `Tom executivo: formal, objetivo e cordial. Vá direto ao ponto, sem rodeios, sem diminutivos e sem exclamações. ${NO_EMOJI}`,
    vibe: 'Sereno e formal. Movimentos contidos, sons suaves.',
  },
  safira: {
    id: 'safira',
    name: 'Safira',
    tagline: 'Analista',
    darkness: 2,
    traits: { formal: 0.75, energia: 0.45, ousadia: 0.3 },
    colors: {
      shell: '#070b14', surface: '#0d1422', surface2: '#060a12', surface3: '#131c30',
      text: '#e6edf8', muted: '#7d8aa3',
      accent: '#5aa9ff', accent2: '#3b82d6', accent3: '#8fd3ff', onAccent: '#04101f',
      warn: '#f0b44c', danger: '#f0615d', ok: '#52d6a0',
      bodyTop: '#2c4066', bodyBottom: '#101a30', bodyEdge: 'rgba(143,211,255,0.45)', eye: '#9fdcff',
    },
    character: { corner: 0.3, eyeGlow: 0.7, scanlines: false, particles: 'ticks' },
    motion: {
      name: 'Corporate', speed: 0.95, bounce: 0.06, squash: 0.4, lift: 0.4, damping: 0.85, glitch: 0,
      idle: { wander: 3, lookAround: 4, hop: 0.4, stretch: 1, wiggle: 0, wink: 0.4, yawn: 1 },
    },
    voice: 'discreto',
    font: 'sans',
    persona: `Tom de analista: preciso, claro e estruturado. Prefira listas curtas e números quando ajudarem; explique o porquê em uma frase. ${NO_EMOJI}`,
    vibe: 'Preciso e atento. Olhos de LED azul, movimentos limpos.',
  },
  indigo: {
    id: 'indigo',
    name: 'Índigo',
    tagline: 'Noturno',
    darkness: 3,
    traits: { formal: 0.6, energia: 0.35, ousadia: 0.4 },
    colors: {
      shell: '#09070f', surface: '#110e1b', surface2: '#070509', surface3: '#191428',
      text: '#ece9f7', muted: '#8d86a6',
      accent: '#9b8cff', accent2: '#7566e0', accent3: '#c4b9ff', onAccent: '#0c0818',
      warn: '#eab15a', danger: '#ee6577', ok: '#6fd3b0',
      bodyTop: '#352f66', bodyBottom: '#14102b', bodyEdge: 'rgba(196,185,255,0.45)', eye: '#d3c9ff',
    },
    character: { corner: 0.32, eyeGlow: 0.8, scanlines: false, particles: 'ticks' },
    motion: {
      name: 'Smooth', speed: 1.15, bounce: 0.03, squash: 0.3, lift: 0.3, damping: 0.95, glitch: 0,
      idle: { wander: 2, lookAround: 4, hop: 0.2, stretch: 1.5, wiggle: 0, wink: 0.3, yawn: 2 },
    },
    voice: 'discreto',
    font: 'sans',
    persona: `Tom sofisticado e calmo, como um assistente de estúdio: elegante, pausado e preciso, sem pressa. ${NO_EMOJI}`,
    vibe: 'Calmo e elegante. Movimentos lentos, brilho violeta.',
  },
  ambar: {
    id: 'ambar',
    name: 'Âmbar',
    tagline: 'Estúdio',
    darkness: 4,
    traits: { formal: 0.5, energia: 0.5, ousadia: 0.45 },
    colors: {
      shell: '#0c0904', surface: '#16110a', surface2: '#080603', surface3: '#201910',
      text: '#f3ebdd', muted: '#9a8c75',
      accent: '#f0a64a', accent2: '#cf8530', accent3: '#ffd08a', onAccent: '#1a0f02',
      warn: '#ffcf6b', danger: '#ee6a4f', ok: '#9bcf6b',
      bodyTop: '#4a3519', bodyBottom: '#1b1209', bodyEdge: 'rgba(255,208,138,0.45)', eye: '#ffd08a',
    },
    character: { corner: 0.32, eyeGlow: 0.85, scanlines: false, particles: 'ticks' },
    motion: {
      name: 'Smooth', speed: 1.1, bounce: 0.05, squash: 0.35, lift: 0.35, damping: 0.92, glitch: 0,
      idle: { wander: 3, lookAround: 3, hop: 0.3, stretch: 1.5, wiggle: 0.2, wink: 0.5, yawn: 1.5 },
    },
    voice: 'discreto',
    font: 'sans',
    persona: `Tom de colega criativo e experiente: caloroso mas enxuto, direto e prático. Sem exageros. ${NO_EMOJI}`,
    vibe: 'Caloroso e focado. Brilho âmbar, ritmo tranquilo.',
  },
  noir: {
    id: 'noir',
    name: 'Noir',
    tagline: 'Sombrio',
    darkness: 5,
    traits: { formal: 0.55, energia: 0.4, ousadia: 0.75 },
    colors: {
      shell: '#030303', surface: '#0b0b0c', surface2: '#020202', surface3: '#131315',
      text: '#ededed', muted: '#7c7c82',
      accent: '#e5484d', accent2: '#b83a3f', accent3: '#ff8a8e', onAccent: '#fff4f4',
      warn: '#e0a84a', danger: '#ff5a5f', ok: '#7fbf8e',
      bodyTop: '#262628', bodyBottom: '#070708', bodyEdge: 'rgba(229,72,77,0.6)', eye: '#f4f4f4',
    },
    character: { corner: 0.26, eyeGlow: 0.9, scanlines: false, particles: 'ticks' },
    motion: {
      name: 'Sharp', speed: 0.9, bounce: 0, squash: 0.22, lift: 0.22, damping: 1, glitch: 0.12,
      idle: { wander: 1.5, lookAround: 5, hop: 0, stretch: 0.6, wiggle: 0, wink: 0.2, yawn: 0.8, glitch: 0.6 },
    },
    voice: 'terminal',
    font: 'sans',
    persona: `Tom seco, sério e minimalista: poucas palavras, nenhuma gentileza desnecessária, sempre competente. Respostas curtíssimas. ${NO_EMOJI}`,
    vibe: 'Frio e silencioso. Olhos brancos, borda vermelha.',
  },
  matrix: {
    id: 'matrix',
    name: 'Matrix',
    tagline: 'Dark hacker',
    darkness: 6,
    traits: { formal: 0.15, energia: 0.7, ousadia: 1 },
    colors: {
      shell: '#000000', surface: '#04100a', surface2: '#010603', surface3: '#07180f',
      text: '#c9ffd9', muted: '#4f9a69',
      accent: '#00ff66', accent2: '#00c250', accent3: '#7dffb0', onAccent: '#001a08',
      warn: '#d8ff3c', danger: '#ff3b5c', ok: '#00ff66',
      bodyTop: '#06190d', bodyBottom: '#010503', bodyEdge: 'rgba(0,255,102,0.75)', eye: '#00ff66',
    },
    character: { corner: 0.14, eyeGlow: 1, scanlines: true, particles: 'glyphs' },
    motion: {
      name: 'Hacker', speed: 0.7, bounce: 0, squash: 0.18, lift: 0.18, damping: 0.8, glitch: 0.6,
      idle: { wander: 1.5, lookAround: 4, hop: 0, stretch: 0.3, wiggle: 0, wink: 0, yawn: 0.4, glitch: 3 },
    },
    voice: 'terminal',
    font: 'mono',
    persona:
      'Tom de operador de terminal / hacker veterano: frases secas e técnicas, jargão de shell, zero floreio, zero elogio. ' +
      'Pode começar respostas com "> " e usar "ok:", "erro:", "feito." Seja cirúrgico e direto. Nunca use emojis.',
    vibe: 'Terminal vivo. Verde fósforo, glitch, mono, direto ao ponto.',
  },
};

export const PALETTE_ORDER: PaletteId[] = ['grafite', 'safira', 'indigo', 'ambar', 'noir', 'matrix'];
export const DEFAULT_PALETTE: PaletteId = 'grafite';

export const isPaletteId = (v: unknown): v is PaletteId => typeof v === 'string' && v in PALETTES;

/** Mistura duas cores #rrggbb (t = peso da segunda) */
export function mix(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [r1, g1, b1] = p(a);
  const [r2, g2, b2] = p(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, '0');
  return `#${c(r1, r2)}${c(g1, g2)}${c(b1, b2)}`;
}

/** Cor da luz (aura + borda) para cada humor — sempre dentro da família da paleta */
export function moodColor(p: Palette, e: CharacterEmotion): string {
  const c = p.colors;
  switch (e) {
    case 'excited':
      return mix(c.accent, '#ffffff', 0.25);
    case 'love':
    case 'thinking':
    case 'dizzy':
      return c.accent2;
    case 'focus':
    case 'curious':
      return c.accent3;
    case 'surprised':
    case 'angry':
      return c.warn;
    case 'furious':
      return c.danger;
    case 'sleepy':
    case 'yawning':
      return mix(c.muted, c.shell, 0.35);
    default:
      return c.accent;
  }
}
