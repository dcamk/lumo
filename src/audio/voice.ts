// Voz de criatura do Lumo (síntese por formantes — a técnica dos "bichinhos" de jogos).
//
// Uma "corda vocal" (dente de serra + um pouco de sopro) passa por três filtros
// passa-banda que imitam a boca formando vogais. Tom de criança, vibrato, micro
// variações de afinação: soa como um ser fofo, não como bipes nem como texto falado.
// Tudo funciona num OfflineAudioContext (SoundEngine renderiza e o Rust toca).

export type Vowel = 'a' | 'e' | 'i' | 'o' | 'u' | 'm' | 'h';

/** Formantes F1–F3 (Hz) de uma voz infantil, com o ganho de cada um */
const FORMANTS: Record<Vowel, [number, number, number]> = {
  a: [1030, 1640, 3350],
  e: [690, 2610, 3570],
  i: [410, 3200, 3800],
  o: [680, 1060, 3180],
  u: [450, 1150, 3200],
  m: [300, 1250, 2600], // boca fechada (hum)
  h: [900, 1800, 3300], // sopro, quase sem voz
};
const FORMANT_GAIN = [1, 0.5, 0.18];

export interface Segment {
  /** vogal deste trecho (o filtro desliza até ela) */
  v: Vowel;
  /** duração (s) */
  d: number;
  /** tom no fim do trecho (Hz) */
  f0: number;
  /** volume no fim do trecho (0–1) */
  g?: number;
}

export interface UtterOptions {
  /** tom inicial (Hz) */
  f0: number;
  /** profundidade do vibrato (Hz) e velocidade */
  vibrato?: number;
  vibratoRate?: number;
  /** quanto de sopro (0–1) */
  breath?: number;
  /** volume geral */
  gain?: number;
  /** ataque (s) */
  attack?: number;
  /** variação aleatória (0–1): cada execução sai um pouco diferente */
  jitter?: number;
}

const rand = (amt: number) => 1 + (Math.random() * 2 - 1) * amt;

let noiseCache: AudioBuffer | null = null;
export function noise(ctx: BaseAudioContext) {
  if (noiseCache && noiseCache.sampleRate === ctx.sampleRate) return noiseCache;
  const buf = ctx.createBuffer(1, ctx.sampleRate * 3, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  noiseCache = buf;
  return buf;
}

/** Fala uma sequência de vogais com contorno de tom. Devolve o fim (s). */
export function utter(ctx: BaseAudioContext, out: AudioNode, t: number, segs: Segment[], o: UtterOptions): number {
  const j = o.jitter ?? 0.05;
  const total = segs.reduce((s, x) => s + x.d, 0);
  const end = t + total;
  const attack = o.attack ?? 0.03;

  // Fonte: dente de serra (cordas vocais) + sopro
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  const f0 = o.f0 * rand(j);
  osc.frequency.setValueAtTime(f0, t);
  const vib = ctx.createOscillator();
  const vibDepth = ctx.createGain();
  vib.frequency.setValueAtTime((o.vibratoRate ?? 5.5) * rand(j), t);
  vibDepth.gain.setValueAtTime(o.vibrato ?? 6, t);
  vib.connect(vibDepth).connect(osc.frequency);

  const voiceAmp = ctx.createGain();
  const breathAmp = ctx.createGain();
  const breathSrc = ctx.createBufferSource();
  breathSrc.buffer = noise(ctx);
  voiceAmp.gain.setValueAtTime(1 - (o.breath ?? 0.15), t);
  breathAmp.gain.setValueAtTime((o.breath ?? 0.15) * 0.6, t);
  osc.connect(voiceAmp);
  breathSrc.connect(breathAmp);

  // "Boca": 3 formantes em paralelo
  const env = ctx.createGain();
  const filters = FORMANT_GAIN.map((fg, k) => {
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.setValueAtTime(k === 0 ? 7 : 10, t);
    bp.frequency.setValueAtTime(FORMANTS[segs[0].v][k] * rand(j * 0.5), t);
    const g = ctx.createGain();
    g.gain.setValueAtTime(fg * 3.2, t);
    voiceAmp.connect(bp);
    breathAmp.connect(bp);
    bp.connect(g).connect(env);
    return bp;
  });

  // Contorno: tom, vogal e volume deslizam trecho a trecho
  const peak = o.gain ?? 0.5;
  env.gain.setValueAtTime(0.0001, t);
  env.gain.linearRampToValueAtTime(peak * (segs[0].g ?? 1), t + attack);
  let at = t;
  for (const s of segs) {
    at += s.d;
    osc.frequency.linearRampToValueAtTime(s.f0 * rand(j * 0.4), at);
    filters.forEach((bp, k) => bp.frequency.linearRampToValueAtTime(FORMANTS[s.v][k], at));
    if (s.g !== undefined) env.gain.linearRampToValueAtTime(Math.max(0.0001, peak * s.g), at);
    if (s.v === 'h') voiceAmp.gain.linearRampToValueAtTime(0.15, at);
  }
  // soltura curta (rampa linear: setTargetAtTime se comporta diferente entre implementações)
  env.gain.linearRampToValueAtTime(0.0001, end + 0.06);

  // Suaviza o brilho do dente de serra (fofo, não estridente)
  const soft = ctx.createBiquadFilter();
  soft.type = 'lowpass';
  soft.frequency.setValueAtTime(4200, t);
  env.connect(soft).connect(out);

  osc.start(t);
  vib.start(t);
  breathSrc.start(t);
  const stop = end + 0.25;
  osc.stop(stop);
  vib.stop(stop);
  breathSrc.stop(stop);
  return end;
}

/** "Plip": gota d'água (cliques frequentes — curto e discreto) */
export function droplet(ctx: BaseAudioContext, out: AudioNode, t: number, pitch = 1) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(1300 * pitch * rand(0.06), t);
  osc.frequency.exponentialRampToValueAtTime(520 * pitch, t + 0.06);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.32, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.1);
}

/** Engolir: "glub" grave e úmido */
export function gulpSound(ctx: BaseAudioContext, out: AudioNode, t: number) {
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(260, t);
  osc.frequency.exponentialRampToValueAtTime(90, t + 0.14);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.55, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
  osc.connect(g).connect(out);
  osc.start(t);
  osc.stop(t + 0.2);
}
