// Desenho puro do Lumo no canvas 2D. Não guarda estado: recebe um "frame" pronto.
// Visual profissional: corpo de vidro/metal com borda de luz, olhos de LED, traços
// finos. As cores, o raio dos cantos, o brilho dos olhos, as linhas de varredura e o
// glitch vêm da paleta (src/theme/palettes.ts).
import { mix, type Palette } from '../theme/palettes';
import type { CharacterEmotion, EyeStyle } from './types';

export interface Particle {
  kind: 'z' | 'ring' | 'cross' | 'dot' | 'glyph';
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number; // ms
  size: number;
  /** caractere (kind 'glyph') */
  ch?: string;
}

export interface Frame {
  size: number; // lado do canvas (px CSS)
  time: number; // ms
  emotion: CharacterEmotion;
  eyeStyle: EyeStyle;
  openness: number; // 0 (fechado) .. 1
  eyeX: number;
  eyeY: number;
  offsetY: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  shakeX: number;
  mouth: number; // 0..1 (bocejo)
  /** Giro da cabeça (rad) para os lados / para cima-baixo — o "3D" estilo Coucou */
  yaw?: number;
  pitch?: number;
  /** 0 = chapado (2D) · 1 = volume total (3D) */
  depth?: number;
  particles: Particle[];
  palette: Palette;
  /** Corpo de vidro polido com reflexos (visual "realista") */
  realistic?: boolean;
  /** 0–1: intensidade do glitch neste quadro */
  glitch?: number;
  dpr?: number;
}

const ANGRY = (e: CharacterEmotion) => e === 'angry' || e === 'furious';
const MONO = 'ui-monospace, "JetBrains Mono", Menlo, Consolas, monospace';

/** Centro do corpo em repouso (deixa espaço em cima para partículas) */
export const bodyCenter = (size: number) => ({ x: size / 2, y: size * 0.56 });
export const bodySize = (size: number) => size * 0.7;

export function drawFrame(ctx: CanvasRenderingContext2D, f: Frame) {
  const S = f.size;
  const bw = bodySize(S);
  const half = bw / 2;
  const c = bodyCenter(S);
  const cx = c.x + f.shakeX;
  const cy = c.y + f.offsetY;
  const angry = ANGRY(f.emotion);
  const pal = f.palette;
  const col = pal.colors;
  const corner = bw * pal.character.corner;

  ctx.clearRect(0, 0, S, S);

  // ---- corpo ------------------------------------------------------------------
  ctx.save();
  ctx.translate(cx, cy + half); // pivô na base: squash "senta" no chão
  ctx.rotate(f.rotation);
  ctx.scale(f.scaleX, f.scaleY);
  ctx.translate(0, -half);

  // 2,5D: virando, o corpo estreita um pouco e os traços do rosto deslizam pela face
  const yaw = f.yaw ?? 0;
  const pitch = f.pitch ?? 0;
  const sy = Math.sin(yaw);
  const sp = Math.sin(pitch);
  ctx.scale(1 - 0.1 * Math.abs(sy), 1 - 0.05 * Math.abs(sp));
  const faceX = sy * bw * 0.26;
  const faceY = sp * bw * 0.16;

  const bodyPath = new Path2D();
  bodyPath.roundRect(-half, -half, bw, bw, corner);
  const tint = f.emotion === 'furious' ? 0.42 : angry ? 0.22 : 0;
  const top = tint ? mix(col.bodyTop, col.danger, tint) : col.bodyTop;
  const bottom = tint ? mix(col.bodyBottom, col.danger, tint) : col.bodyBottom;
  const edge = tint ? mix(col.accent, col.danger, 0.8) : col.bodyEdge;
  const real = !!f.realistic;
  const grad = ctx.createLinearGradient(0, -half, 0, half);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fill(bodyPath);
  if (real) drawGlassBody(ctx, bodyPath, bw, half, pal, tint ? col.danger : col.accent, f.time);

  // Brilho de vidro no topo (linear, discreto) e luz de LED na base
  ctx.save();
  ctx.clip(bodyPath);
  const dark = pal.character.eyeGlow > 0 && !real;
  if (!real) {
    const gloss = ctx.createLinearGradient(0, -half, 0, -half + bw * 0.5);
    gloss.addColorStop(0, `rgba(255,255,255,${dark ? 0.12 : 0.34})`);
    gloss.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = gloss;
    ctx.fillRect(-half, -half, bw, bw * 0.5);
  }
  if (dark) {
    const led = ctx.createLinearGradient(-half, 0, half, 0);
    const lc = tint ? col.danger : col.accent;
    led.addColorStop(0, 'rgba(0,0,0,0)');
    led.addColorStop(0.5, lc);
    led.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = 0.55 + Math.sin(f.time * 0.003) * 0.15;
    ctx.fillStyle = led;
    ctx.fillRect(-half, half - bw * 0.065, bw, Math.max(1.2, bw * 0.02));
    ctx.globalAlpha = 1;
  }

  // Volume: o lado que se afasta escurece, o que vem para a frente ganha luz de borda
  if (Math.abs(sy) > 0.01 || Math.abs(sp) > 0.01) {
    const dir = Math.sign(sy) || 1;
    const shade = ctx.createLinearGradient(-dir * half, 0, dir * half, 0);
    shade.addColorStop(0, `rgba(0, 0, 0, ${0.38 * Math.abs(sy)})`);
    shade.addColorStop(0.45, 'rgba(0, 0, 0, 0)');
    shade.addColorStop(0.9, 'rgba(255, 255, 255, 0)');
    shade.addColorStop(1, `rgba(255, 255, 255, ${0.22 * Math.abs(sy)})`);
    ctx.fillStyle = shade;
    ctx.fillRect(-half, -half, bw, bw);
    const topShade = ctx.createLinearGradient(0, -half, 0, half);
    topShade.addColorStop(0, `rgba(255,255,255,${Math.max(0, -sp) * 0.18})`);
    topShade.addColorStop(1, `rgba(0,0,0,${Math.max(0, sp) * 0.3})`);
    ctx.fillStyle = topShade;
    ctx.fillRect(-half, -half, bw, bw);
  }

  // Linhas de varredura (paletas "terminal"): rolam devagar pelo corpo
  if (pal.character.scanlines) {
    const step = Math.max(2, bw * 0.045);
    const off = (f.time * 0.012) % step;
    ctx.fillStyle = 'rgba(0, 255, 102, 0.08)';
    for (let y = -half + off; y < half; y += step) ctx.fillRect(-half, y, bw, Math.max(0.6, step * 0.35));
  }
  ctx.restore();

  if (real) {
    // Aresta de vidro: luz fria em cima, quase sumindo embaixo
    const rim = ctx.createLinearGradient(0, -half, 0, half);
    rim.addColorStop(0, 'rgba(255,255,255,0.7)');
    rim.addColorStop(0.5, 'rgba(255,255,255,0.12)');
    rim.addColorStop(1, 'rgba(255,255,255,0.3)');
    ctx.strokeStyle = rim;
    ctx.lineWidth = Math.max(0.8, S * 0.012);
  } else {
    ctx.strokeStyle = edge;
    ctx.lineWidth = Math.max(0.75, S * 0.016);
  }
  ctx.stroke(bodyPath);

  // Rosto: desliza com o giro e fica preso dentro do corpo
  ctx.save();
  ctx.clip(bodyPath);
  ctx.translate(faceX, faceY);

  if (f.emotion === 'eager') drawPortFace(ctx, bw, f.mouth, f.time, sy, pal);
  else drawEyes(ctx, f, bw, pal);

  if (f.emotion !== 'eager' && f.mouth > 0.02) {
    // Boca pequena (bocejo / surpresa): fenda de LED
    const mw = bw * 0.2 * (0.5 + f.mouth * 0.5);
    const mh = bw * 0.14 * f.mouth;
    ctx.fillStyle = col.eye;
    glow(ctx, col.eye, bw, pal.character.eyeGlow);
    ctx.beginPath();
    ctx.roundRect(-mw / 2, bw * 0.22 - mh / 2, mw, Math.max(1.2, mh), Math.min(mw, Math.max(1.2, mh)) / 2);
    ctx.fill();
  }
  ctx.restore(); // rosto
  ctx.restore(); // corpo

  // ---- adornos acima da cabeça -------------------------------------------------
  const headTop = cy - half;
  if (f.emotion === 'dizzy') drawProcessing(ctx, cx, headTop, bw, f.time, pal);
  if (f.emotion === 'thinking') drawThinkingDots(ctx, cx + half * 0.9, headTop, bw, f.time, pal);
  if (angry) drawWarning(ctx, cx + half * 0.78, headTop + bw * 0.04, bw, f.time, f.emotion === 'furious' ? col.danger : col.warn);

  drawParticles(ctx, f.particles, f.time, pal);

  if ((f.glitch ?? 0) > 0.02) applyGlitch(ctx, f, bw);
}

/** Corpo "realista": vidro escuro polido, com reflexo curvo, bisel interno e LED na base */
function drawGlassBody(ctx: CanvasRenderingContext2D, path: Path2D, bw: number, half: number, pal: Palette, led: string, time: number) {
  ctx.save();
  ctx.clip(path);
  // profundidade: centro mais escuro, bordas levemente mais claras (espessura do vidro)
  const depth = ctx.createRadialGradient(0, 0, bw * 0.15, 0, 0, bw * 0.78);
  const soft = pal.darkness <= 1 ? 0.4 : 1; // corpo claro: não "suja" o centro
  depth.addColorStop(0, `rgba(0,0,0,${0.55 * soft})`);
  depth.addColorStop(0.7, `rgba(0,0,0,${0.12 * soft})`);
  depth.addColorStop(1, 'rgba(255,255,255,0.12)');
  ctx.fillStyle = depth;
  ctx.fillRect(-half, -half, bw, bw);
  // reflexo do ambiente: faixa clara inclinada no canto superior esquerdo
  ctx.save();
  ctx.rotate(-0.5);
  const sheen = ctx.createLinearGradient(-bw * 0.75, 0, -bw * 0.2, 0);
  sheen.addColorStop(0, 'rgba(255,255,255,0)');
  sheen.addColorStop(0.45, 'rgba(255,255,255,0.2)');
  sheen.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = sheen;
  ctx.fillRect(-bw * 0.75, -bw * 0.95, bw * 0.55, bw * 1.5);
  ctx.restore();
  // brilho especular no topo
  const spec = ctx.createLinearGradient(0, -half, 0, -half + bw * 0.34);
  spec.addColorStop(0, 'rgba(255,255,255,0.3)');
  spec.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = spec;
  ctx.beginPath();
  ctx.roundRect(-half + bw * 0.07, -half + bw * 0.045, bw * 0.86, bw * 0.28, bw * 0.16);
  ctx.fill();
  // reflexo suave embaixo (luz rebatida)
  const bounce = ctx.createLinearGradient(0, half - bw * 0.22, 0, half);
  bounce.addColorStop(0, 'rgba(255,255,255,0)');
  bounce.addColorStop(1, 'rgba(255,255,255,0.14)');
  ctx.fillStyle = bounce;
  ctx.fillRect(-half, half - bw * 0.22, bw, bw * 0.22);
  // bisel interno
  ctx.strokeStyle = 'rgba(0,0,0,0.55)';
  ctx.lineWidth = Math.max(1, bw * 0.03);
  ctx.stroke(path);
  // LED indicador na base (pisca devagar)
  const lx = -half + bw * 0.14;
  const ly = half - bw * 0.11;
  ctx.globalAlpha = 0.65 + Math.sin(time * 0.004) * 0.3;
  ctx.shadowColor = led;
  ctx.shadowBlur = bw * 0.06;
  ctx.fillStyle = led;
  ctx.beginPath();
  ctx.arc(lx, ly, Math.max(1.1, bw * 0.017), 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** Brilho de LED nos olhos / boca (desligado nas paletas sem brilho) */
function glow(ctx: CanvasRenderingContext2D, color: string, bw: number, amount: number) {
  if (amount <= 0) {
    ctx.shadowBlur = 0;
    return;
  }
  ctx.shadowColor = color;
  ctx.shadowBlur = bw * 0.1 * amount;
}

function drawEyes(ctx: CanvasRenderingContext2D, f: Frame, bw: number, pal: Palette) {
  const col = pal.colors;
  const spacing = bw * 0.29;
  const ew = bw * 0.135;
  const eh = bw * 0.4;
  const o = Math.max(0, Math.min(1, f.openness));
  ctx.fillStyle = col.eye;
  ctx.strokeStyle = col.eye;
  ctx.lineCap = 'round';
  glow(ctx, col.eye, bw, f.realistic ? Math.max(0.85, pal.character.eyeGlow) : pal.character.eyeGlow);

  const pill = (x: number, y: number, w: number, h: number) => {
    const hh = Math.max(w * 0.3, h * o); // fechado vira uma linha
    ctx.beginPath();
    ctx.roundRect(x - w / 2, y - hh / 2, w, hh, Math.min(w, hh) / 2);
    ctx.fill();
  };
  const arc = (x: number, y: number, width = 0.055) => {
    const r = ew * 1.05;
    ctx.beginPath();
    ctx.lineWidth = Math.max(1.4, bw * width);
    ctx.save();
    ctx.translate(x, y + r * 0.3);
    ctx.scale(1, Math.max(0.2, o));
    ctx.arc(0, 0, r, Math.PI * 1.08, Math.PI * 1.92, false);
    ctx.restore();
    ctx.stroke();
  };

  // 2,5D: com a cabeça virada, os olhos se aproximam e o de trás afina
  const sy = Math.sin(f.yaw ?? 0);
  for (const side of [-1, 1] as const) {
    const x = side * (spacing / 2) * (1 - 0.25 * Math.abs(sy)) + f.eyeX;
    const y = f.eyeY;
    const far = Math.max(0, -side * sy);
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(1 - 0.45 * far, 1);
    ctx.translate(-x, -y);
    const right = side === 1;

    switch (f.eyeStyle) {
      case 'normal':
        pill(x, y, ew, eh);
        break;
      case 'focus':
        // Olhar determinado: barra mais baixa
        pill(x, y + eh * 0.1, ew * 1.05, eh * 0.6);
        break;
      case 'happy':
        arc(x, y);
        break;
      case 'wink':
        if (right) arc(x, y);
        else pill(x, y, ew, eh);
        break;
      case 'surprised': {
        const r = ew * 0.85;
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * Math.max(0.15, o), 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'sleepy': {
        const w = eh * 0.6;
        ctx.beginPath();
        ctx.roundRect(x - w / 2, y + eh * 0.1, w, ew * 0.4, ew * 0.2);
        ctx.fill();
        break;
      }
      case 'angry': {
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(right ? -0.38 : 0.38);
        const w = eh * 0.62;
        const h = ew * 0.6 * Math.max(0.4, o);
        ctx.beginPath();
        ctx.roundRect(-w / 2, -h / 2, w, h, h / 2);
        ctx.fill();
        ctx.restore();
        break;
      }
      case 'curious': {
        const r = Math.min(ew * (right ? 0.62 : 1.1), bw * 0.15);
        ctx.beginPath();
        ctx.ellipse(x, y, r, r * Math.max(0.15, o), 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case 'heart': {
        // "Gostei": o sorriso dos olhos fica mais largo e pulsa suave, na cor de destaque
        ctx.save();
        const pulse = 1 + Math.sin(f.time * 0.008) * 0.08;
        ctx.strokeStyle = col.accent3;
        glow(ctx, col.accent3, bw, Math.max(0.5, pal.character.eyeGlow));
        ctx.translate(x, y);
        ctx.scale(pulse, pulse);
        arc(0, 0, 0.07);
        ctx.restore();
        break;
      }
      case 'spiral': {
        // Processando: anel de carregamento girando (no lugar do olho em espiral)
        ctx.save();
        ctx.translate(x, y);
        ctx.lineWidth = Math.max(1.2, bw * 0.04);
        const r = ew * 0.95;
        const a0 = f.time * 0.009 * (right ? 1 : -1);
        ctx.beginPath();
        ctx.arc(0, 0, r, a0, a0 + Math.PI * 1.2);
        ctx.stroke();
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(0, 0, r, a0 + Math.PI * 1.2, a0 + Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        break;
      }
    }
    ctx.restore();
  }
  ctx.shadowBlur = 0;
}

/** Orbita de pontos: "processando" (no lugar das estrelinhas de tontura) */
function drawProcessing(ctx: CanvasRenderingContext2D, cx: number, top: number, bw: number, t: number, pal: Palette) {
  ctx.save();
  ctx.fillStyle = pal.colors.accent3;
  for (let i = 0; i < 3; i++) {
    const a = t * 0.006 + (i * Math.PI * 2) / 3;
    const x = cx + Math.cos(a) * bw * 0.34;
    const y = top - bw * 0.02 + Math.sin(a) * bw * 0.07;
    ctx.globalAlpha = 0.45 + (Math.sin(a) + 1) * 0.27;
    ctx.beginPath();
    ctx.arc(x, y, bw * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawThinkingDots(ctx: CanvasRenderingContext2D, x: number, top: number, bw: number, t: number, pal: Palette) {
  const step = Math.floor(t / 350) % 4;
  ctx.save();
  ctx.fillStyle = pal.colors.accent3;
  for (let i = 0; i < Math.min(step, 3); i++) {
    ctx.beginPath();
    ctx.arc(x + i * bw * 0.11, top - i * bw * 0.04, bw * 0.03, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

/** Triângulo de aviso com "!" (no lugar da marca de raiva) */
function drawWarning(ctx: CanvasRenderingContext2D, x: number, y: number, bw: number, t: number, color: string) {
  const s = bw * 0.1;
  ctx.save();
  ctx.globalAlpha = 0.65 + Math.sin(t * 0.02) * 0.3;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.1, bw * 0.03);
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.lineTo(x + s, y + s * 0.8);
  ctx.lineTo(x - s, y + s * 0.8);
  ctx.closePath();
  ctx.stroke();
  ctx.fillRect(x - bw * 0.0125, y - s * 0.35, bw * 0.025, s * 0.7);
  ctx.beginPath();
  ctx.arc(x, y + s * 0.55, bw * 0.014, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

function drawParticles(ctx: CanvasRenderingContext2D, ps: Particle[], t: number, pal: Palette) {
  const col = pal.colors;
  for (const p of ps) {
    const age = (t - p.born) / p.life;
    if (age < 0 || age > 1) continue;
    const alpha = age < 0.15 ? age / 0.15 : 1 - (age - 0.15) / 0.85;
    ctx.save();
    ctx.globalAlpha = Math.max(0, alpha) * 0.85;
    switch (p.kind) {
      case 'z':
        ctx.fillStyle = col.accent3;
        ctx.font = `600 ${Math.max(7, p.size * 0.8)}px ${MONO}`;
        ctx.fillText('z', p.x, p.y);
        break;
      case 'ring':
        ctx.strokeStyle = col.accent2;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.5 + age * 1.8), 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'cross': {
        const r = p.size * (1 - age * 0.4);
        ctx.strokeStyle = col.accent3;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(p.x - r, p.y);
        ctx.lineTo(p.x + r, p.y);
        ctx.moveTo(p.x, p.y - r);
        ctx.lineTo(p.x, p.y + r);
        ctx.stroke();
        break;
      }
      case 'dot':
        ctx.fillStyle = col.accent3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size * (0.5 + age * 0.5), 0, Math.PI * 2);
        ctx.fill();
        break;
      case 'glyph':
        ctx.fillStyle = col.accent;
        ctx.font = `700 ${Math.max(7, p.size)}px ${MONO}`;
        ctx.fillText(p.ch ?? '0', p.x, p.y);
        break;
    }
    ctx.restore();
  }
}

/**
 * Esperando o arquivo: o rosto vira uma porta de recebimento — olhos em barras finas
 * em cima e uma fenda larga com setas descendo ("solte aqui"). A fenda "respira" (mouth 0..1).
 */
function drawPortFace(ctx: CanvasRenderingContext2D, bw: number, mouth: number, time: number, yawSin: number, pal: Palette) {
  const col = pal.colors;
  const open = 0.85 + Math.max(0, Math.min(1, mouth)) * 0.15;
  const mw = bw * 0.78 * (1 - 0.12 * Math.abs(yawSin));
  const mh = bw * 0.34 * open;
  const top = -bw * 0.04;

  // olhos: duas barras finas em cima
  ctx.strokeStyle = col.eye;
  ctx.lineCap = 'round';
  ctx.lineWidth = Math.max(1.4, bw * 0.045);
  glow(ctx, col.eye, bw, pal.character.eyeGlow);
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(side * bw * 0.36, top - bw * 0.2);
    ctx.lineTo(side * bw * 0.14, top - bw * 0.2);
    ctx.stroke();
  }

  // fenda
  const accent = pal.character.eyeGlow > 0 ? col.accent : col.eye;
  ctx.beginPath();
  ctx.roundRect(-mw / 2, top, mw, mh, mh * 0.45);
  ctx.fillStyle = pal.character.eyeGlow > 0 ? '#000' : mix(col.bodyBottom, '#000', 0.55);
  ctx.fill();
  ctx.lineWidth = Math.max(1.2, bw * 0.03);
  ctx.strokeStyle = accent;
  glow(ctx, accent, bw, Math.max(0.5, pal.character.eyeGlow));
  ctx.stroke();
  ctx.shadowBlur = 0;

  // setas descendo
  const phase = (time * 0.0018) % 1;
  ctx.lineWidth = Math.max(1.3, bw * 0.035);
  ctx.lineJoin = 'round';
  for (let i = 0; i < 3; i++) {
    const p = (phase + i / 3) % 1;
    const x = (i - 1) * bw * 0.2;
    const y = top + mh * (0.25 + p * 0.5);
    const s = bw * 0.05;
    ctx.globalAlpha = Math.sin(p * Math.PI) * 0.9;
    ctx.beginPath();
    ctx.moveTo(x - s, y - s * 0.6);
    ctx.lineTo(x, y + s * 0.4);
    ctx.lineTo(x + s, y - s * 0.6);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---- glitch ---------------------------------------------------------------------------------

let strip: HTMLCanvasElement | null = null;
const hash = (n: number) => {
  const x = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return x - Math.floor(x);
};

/** Fatias horizontais deslocadas + fantasma de cor, como sinal digital falhando */
function applyGlitch(ctx: CanvasRenderingContext2D, f: Frame, bw: number) {
  const cv = ctx.canvas;
  const g = Math.min(1, f.glitch ?? 0);
  const seed = Math.floor(f.time / 55);
  strip ??= document.createElement('canvas');
  const sctx = strip.getContext('2d');
  if (!sctx) return;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const dpr = f.dpr ?? 1;
  const n = 2 + Math.round(g * 3);
  for (let i = 0; i < n; i++) {
    const y = Math.floor(hash(seed * 7 + i) * cv.height * 0.8);
    const h = Math.max(2, Math.floor((0.04 + hash(seed * 13 + i) * 0.1) * cv.height));
    const dx = Math.round((hash(seed * 19 + i) - 0.5) * 2 * bw * 0.22 * g * dpr);
    strip.width = cv.width;
    strip.height = h;
    sctx.drawImage(cv, 0, y, cv.width, h, 0, 0, cv.width, h);
    ctx.clearRect(0, y, cv.width, h);
    ctx.drawImage(strip, dx, y);
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = 0.35 * g;
    ctx.drawImage(strip, -dx, y);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}
