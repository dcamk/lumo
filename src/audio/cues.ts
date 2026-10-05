// Sons do Lumo por estilo de voz. Cada "cue" (clique, sucesso, alerta…) existe em três
// timbres; a paleta escolhe o padrão:
//  - discreto: sinos suaves de interface (sines com decaimento) — profissional
//  - terminal: bips curtos de onda quadrada/dente de serra — "hacker"
//  - criatura: a voz formântica original (fofa)
// Cada som é sintetizado num OfflineAudioContext (SoundEngine) — nunca usar
// AudioParam.setTargetAtTime aqui (quebra no node-web-audio-api dos testes): só rampas.
import { droplet, gulpSound, noise, utter } from './voice';
import type { VoiceStyle } from '../theme/palettes';

export type Voice = (ctx: BaseAudioContext, out: AudioNode, t: number) => void;

export type Cue =
  | 'pop' | 'chirp' | 'purr' | 'alert' | 'sigh' | 'angry' | 'curious'
  | 'hop' | 'love' | 'dizzy' | 'wake' | 'yawn' | 'eager' | 'gulp';

export interface CueDef {
  /** Quantas variações diferentes sintetizar (sorteadas a cada vez) */
  n: number;
  voice: Voice;
}

const rand = (a: number) => 1 + (Math.random() * 2 - 1) * a;

// ---- ferramentas -----------------------------------------------------------------------

interface ToneOpts {
  f: number;
  /** frequência final (glide exponencial) */
  to?: number;
  d: number;
  type?: OscillatorType;
  gain?: number;
  attack?: number;
  /** passa-baixa (Hz) */
  lp?: number;
  /** segundo harmônico (0–1) — dá brilho de sino */
  bell?: number;
}

function tone(ctx: BaseAudioContext, out: AudioNode, t: number, o: ToneOpts) {
  const g = ctx.createGain();
  const peak = o.gain ?? 0.2;
  const attack = o.attack ?? 0.004;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + o.d);
  let tail: AudioNode = g;
  if (o.lp) {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(o.lp, t);
    g.connect(lp);
    tail = lp;
  }
  tail.connect(out);
  const voices: [number, number][] = [[1, 1]];
  if (o.bell) voices.push([2.0, o.bell]);
  for (const [mult, amp] of voices) {
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.f * mult, t);
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to * mult, t + o.d);
    if (amp === 1) osc.connect(g);
    else {
      const ag = ctx.createGain();
      ag.gain.setValueAtTime(amp, t);
      osc.connect(ag).connect(g);
    }
    osc.start(t);
    osc.stop(t + o.d + 0.05);
  }
}

function hiss(ctx: BaseAudioContext, out: AudioNode, t: number, o: { d: number; gain: number; from: number; to: number }) {
  const src = ctx.createBufferSource();
  src.buffer = noise(ctx);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(o.from, t);
  lp.frequency.exponentialRampToValueAtTime(o.to, t + o.d);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(o.gain, t + o.d * 0.25);
  g.gain.linearRampToValueAtTime(0.0001, t + o.d);
  src.connect(lp).connect(g).connect(out);
  src.start(t);
  src.stop(t + o.d + 0.05);
}

// ---- discreto: sinos de interface -------------------------------------------------------

const DISCRETO: Record<Cue, CueDef> = {
  pop: { n: 3, voice: (c, o, t) => tone(c, o, t, { f: 1500 * rand(0.05), to: 900, d: 0.05, gain: 0.14 }) },
  chirp: {
    n: 2,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 659, d: 0.2, gain: 0.2, bell: 0.25 });
      tone(c, o, t + 0.09, { f: 988, d: 0.32, gain: 0.2, bell: 0.2 });
    },
  },
  purr: {
    n: 1,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 233, d: 0.24, gain: 0.1, lp: 900, attack: 0.03 });
      tone(c, o, t + 0.18, { f: 233, d: 0.28, gain: 0.08, lp: 900, attack: 0.03 });
    },
  },
  alert: {
    n: 1,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 784, d: 0.16, gain: 0.22, type: 'triangle' });
      tone(c, o, t + 0.13, { f: 587, d: 0.28, gain: 0.22, type: 'triangle' });
    },
  },
  sigh: { n: 1, voice: (c, o, t) => hiss(c, o, t, { d: 0.6, gain: 0.12, from: 1400, to: 250 }) },
  angry: {
    n: 1,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 118, to: 80, d: 0.2, gain: 0.3 });
      tone(c, o, t, { f: 82, d: 0.22, gain: 0.1, type: 'sawtooth', lp: 380 });
    },
  },
  curious: { n: 2, voice: (c, o, t) => tone(c, o, t, { f: 523 * rand(0.03), to: 784, d: 0.18, gain: 0.18, bell: 0.15 }) },
  hop: { n: 2, voice: (c, o, t) => tone(c, o, t, { f: 880 * rand(0.04), d: 0.045, gain: 0.09 }) },
  love: {
    n: 1,
    voice: (c, o, t) => {
      for (const f of [523, 659, 784]) tone(c, o, t, { f, d: 0.6, gain: 0.09, attack: 0.08, bell: 0.15 });
    },
  },
  dizzy: {
    n: 1,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 330, d: 0.7, gain: 0.1, attack: 0.05 });
      tone(c, o, t, { f: 338, d: 0.7, gain: 0.1, attack: 0.05 });
    },
  },
  wake: { n: 1, voice: (c, o, t) => tone(c, o, t, { f: 420, to: 840, d: 0.14, gain: 0.13 }) },
  yawn: { n: 1, voice: (c, o, t) => tone(c, o, t, { f: 300, to: 170, d: 0.8, gain: 0.1, lp: 520, attack: 0.15 }) },
  eager: { n: 1, voice: (c, o, t) => tone(c, o, t, { f: 660, d: 0.5, gain: 0.07, bell: 0.2 }) },
  gulp: {
    n: 1,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 300, to: 120, d: 0.14, gain: 0.28 });
      tone(c, o, t + 0.15, { f: 880, d: 0.18, gain: 0.12, bell: 0.2 });
    },
  },
};

// ---- terminal: bips ---------------------------------------------------------------------

const sq = (c: BaseAudioContext, o: AudioNode, t: number, f: number, d: number, gain: number, to?: number) =>
  tone(c, o, t, { f, to, d, gain, type: 'square', lp: 5200 });

const TERMINAL: Record<Cue, CueDef> = {
  pop: { n: 3, voice: (c, o, t) => sq(c, o, t, 1800 * rand(0.06), 0.03, 0.08) },
  chirp: {
    n: 1,
    voice: (c, o, t) => {
      sq(c, o, t, 880, 0.05, 0.09);
      sq(c, o, t + 0.06, 1320, 0.05, 0.09);
      sq(c, o, t + 0.12, 1760, 0.09, 0.09);
    },
  },
  purr: {
    n: 3,
    voice: (c, o, t) => {
      for (let i = 0; i < 5; i++) sq(c, o, t + i * 0.045, 1200 + Math.random() * 1400, 0.03, 0.05);
    },
  },
  alert: {
    n: 1,
    voice: (c, o, t) => {
      sq(c, o, t, 1000, 0.08, 0.11);
      sq(c, o, t + 0.12, 1000, 0.08, 0.11);
    },
  },
  sigh: { n: 1, voice: (c, o, t) => tone(c, o, t, { f: 520, to: 70, d: 0.4, gain: 0.09, type: 'sawtooth', lp: 800 }) },
  angry: {
    n: 1,
    voice: (c, o, t) => {
      sq(c, o, t, 92, 0.26, 0.16);
      hiss(c, o, t, { d: 0.24, gain: 0.08, from: 2400, to: 600 });
    },
  },
  curious: {
    n: 1,
    voice: (c, o, t) => {
      sq(c, o, t, 600, 0.04, 0.08);
      sq(c, o, t + 0.05, 800, 0.04, 0.08);
      sq(c, o, t + 0.1, 1000, 0.06, 0.08);
    },
  },
  hop: { n: 2, voice: (c, o, t) => sq(c, o, t, 1200 * rand(0.05), 0.03, 0.07) },
  love: {
    n: 1,
    voice: (c, o, t) => {
      tone(c, o, t, { f: 660, d: 0.18, gain: 0.12, type: 'triangle' });
      tone(c, o, t + 0.12, { f: 880, d: 0.26, gain: 0.12, type: 'triangle' });
    },
  },
  dizzy: {
    n: 3,
    voice: (c, o, t) => {
      for (let i = 0; i < 7; i++) sq(c, o, t + i * 0.065, 300 + Math.random() * 1500, 0.05, 0.06);
    },
  },
  wake: { n: 1, voice: (c, o, t) => sq(c, o, t, 200, 0.13, 0.09, 1400) },
  yawn: { n: 1, voice: (c, o, t) => tone(c, o, t, { f: 400, to: 60, d: 0.7, gain: 0.08, type: 'sawtooth', lp: 500, attack: 0.1 }) },
  eager: { n: 1, voice: (c, o, t) => tone(c, o, t, { f: 900, d: 0.55, gain: 0.06, bell: 0.3 }) },
  gulp: {
    n: 1,
    voice: (c, o, t) => {
      sq(c, o, t, 400, 0.1, 0.14, 100);
      [600, 900, 1200].forEach((f, i) => sq(c, o, t + 0.13 + i * 0.05, f, 0.04, 0.08));
    },
  },
};

// ---- criatura: a voz formântica original (src/audio/voice.ts) -------------------------

const CRIATURA: Record<Cue, CueDef> = {
  pop: { n: 3, voice: (c, o, t) => droplet(c, o, t, 0.9 + Math.random() * 0.25) },
  chirp: {
    n: 3,
    voice: (c, o, t) => {
      const end = utter(c, o, t, [{ v: 'e', d: 0.09, f0: 560 }, { v: 'h', d: 0.03, f0: 520, g: 0.2 }], { f0: 470, gain: 0.42 });
      utter(c, o, end + 0.02, [{ v: 'e', d: 0.07, f0: 700 }, { v: 'i', d: 0.08, f0: 760, g: 0.6 }], { f0: 620, gain: 0.45, vibrato: 10 });
    },
  },
  purr: {
    n: 2,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'm', d: 0.35, f0: 330 }, { v: 'm', d: 0.45, f0: 300, g: 0.6 }, { v: 'm', d: 0.2, f0: 310, g: 0.1 }], {
        f0: 300, gain: 0.22, vibrato: 4, vibratoRate: 4.5, attack: 0.08,
      }),
  },
  alert: {
    n: 2,
    voice: (c, o, t) => {
      const end = utter(c, o, t, [{ v: 'o', d: 0.13, f0: 600 }], { f0: 560, gain: 0.5 });
      utter(c, o, end + 0.05, [{ v: 'o', d: 0.16, f0: 440, g: 0.7 }], { f0: 470, gain: 0.48 });
    },
  },
  sigh: {
    n: 1,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'h', d: 0.25, f0: 330 }, { v: 'a', d: 0.5, f0: 220, g: 0.3 }], { f0: 360, gain: 0.4, breath: 0.7, attack: 0.12 }),
  },
  angry: {
    n: 2,
    voice: (c, o, t) => {
      const end = utter(c, o, t, [{ v: 'm', d: 0.12, f0: 240 }, { v: 'u', d: 0.06, f0: 210 }], { f0: 260, gain: 0.5, vibrato: 14, vibratoRate: 22 });
      utter(c, o, end, [{ v: 'h', d: 0.12, f0: 200, g: 0.1 }], { f0: 220, gain: 0.35, breath: 0.9 });
    },
  },
  curious: {
    n: 3,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'm', d: 0.08, f0: 380 }, { v: 'u', d: 0.08, f0: 470 }, { v: 'i', d: 0.12, f0: 640, g: 0.7 }], { f0: 360, gain: 0.42 }),
  },
  hop: {
    n: 2,
    voice: (c, o, t) => void utter(c, o, t, [{ v: 'u', d: 0.05, f0: 560 }, { v: 'o', d: 0.05, f0: 660, g: 0.4 }], { f0: 500, gain: 0.3 }),
  },
  love: {
    n: 2,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'a', d: 0.2, f0: 620 }, { v: 'o', d: 0.25, f0: 520 }, { v: 'u', d: 0.25, f0: 440, g: 0.4 }], {
        f0: 560, gain: 0.42, vibrato: 12, vibratoRate: 6, attack: 0.05,
      }),
  },
  dizzy: {
    n: 1,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'u', d: 0.3, f0: 520 }, { v: 'o', d: 0.3, f0: 360 }, { v: 'u', d: 0.2, f0: 300, g: 0.3 }], {
        f0: 600, gain: 0.4, vibrato: 45, vibratoRate: 7,
      }),
  },
  wake: {
    n: 2,
    voice: (c, o, t) => void utter(c, o, t, [{ v: 'a', d: 0.1, f0: 640 }, { v: 'a', d: 0.08, f0: 720, g: 0.4 }], { f0: 520, gain: 0.45 }),
  },
  yawn: {
    n: 1,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'a', d: 0.7, f0: 420 }, { v: 'a', d: 0.5, f0: 300, g: 0.7 }, { v: 'o', d: 0.3, f0: 260 }, { v: 'm', d: 0.3, f0: 240, g: 0.2 }], {
        f0: 340, gain: 0.4, breath: 0.35, vibrato: 5, vibratoRate: 3, attack: 0.2,
      }),
  },
  eager: {
    n: 3,
    voice: (c, o, t) =>
      void utter(c, o, t, [{ v: 'a', d: 0.5, f0: 470 }, { v: 'a', d: 0.6, f0: 540, g: 0.9 }, { v: 'a', d: 0.35, f0: 560, g: 0.15 }], {
        f0: 430, gain: 0.26, breath: 0.3, vibrato: 7, vibratoRate: 6, attack: 0.18, jitter: 0.08,
      }),
  },
  gulp: {
    n: 2,
    voice: (c, o, t) => {
      gulpSound(c, o, t);
      const end = utter(c, o, t + 0.16, [{ v: 'm', d: 0.05, f0: 520 }, { v: 'a', d: 0.1, f0: 600 }, { v: 'm', d: 0.08, f0: 480, g: 0.3 }], { f0: 480, gain: 0.45 });
      utter(c, o, end + 0.06, [{ v: 'm', d: 0.12, f0: 640 }, { v: 'm', d: 0.1, f0: 700, g: 0.2 }], { f0: 560, gain: 0.35, vibrato: 10 });
    },
  },
};

/** Compensa o volume: os timbres limpos são sintetizados mais baixos que a voz de criatura */
export const STYLE_GAIN: Record<VoiceStyle, number> = { discreto: 2.1, terminal: 2.1, criatura: 1 };

export const CUES: Record<VoiceStyle, Record<Cue, CueDef>> = {
  discreto: DISCRETO,
  terminal: TERMINAL,
  criatura: CRIATURA,
};
