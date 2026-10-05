import React, { useEffect, useRef } from 'react';
import { sound } from '../audio/SoundEngine';
import { tryInvoke } from '../lib/tauri';
import { reducedMotion } from '../lib/motion';
import { getLook, getPalette } from '../theme/store';
import { bodyCenter, bodySize, drawFrame, type Particle } from './draw';
import { EYE_FOR_EMOTION, type CharacterEmotion, type EyeStyle, type IdleBehavior } from './types';

export type { CharacterEmotion } from './types';

interface CharacterCanvasProps {
  /** Emoção vinda do app (foco, pensando, feliz...). 'idle' libera os comportamentos próprios. */
  emotion?: CharacterEmotion;
  /** Lado do canvas em px. O pai calcula a partir do tamanho da janela. */
  size?: number;
  /** Quanto o Lumo pode andar para cada lado (px) quando estiver ocioso. 0 = parado. */
  roam?: number;
  interactive?: boolean;
  /**
   * Seguir o cursor na tela toda (poll via Rust). Sem isso, só quando o mouse
   * está sobre a janela do Lumo. Se as coordenadas globais se mostrarem erradas,
   * o poll se desliga e `onGlobalCursorBroken` é chamado.
   */
  globalCursor?: boolean;
  onGlobalCursorBroken?: () => void;
  /** Recebe quantos cliques houve nos últimos 2 s (1 = clique simples) */
  onClick?: (burst: number) => void;
  /** Ponto (clientX/Y) para onde olhar — ex.: o arquivo sendo arrastado */
  lookAt?: { x: number; y: number } | null;
  className?: string;
}

/** Comportamentos espontâneos só começam após este tempo sem interação COM o Lumo */
const IDLE_BEHAVIOR_AFTER = 30_000;
/** Sem mexer o mouse/teclado em lugar nenhum por este tempo, ele cochila */
const SLEEP_AFTER = 5 * 60_000;
const CURSOR_POLL_MS = 50;
/** Divergência (px) entre o cursor global e o mousemove local que indica coordenadas erradas */
const GLOBAL_MISMATCH_PX = 40;
const GLOBAL_MISMATCH_LIMIT = 3;
/** Caracteres que sobem do Lumo nas paletas "terminal" */
const GLYPHS = '01{}</>#$_;*'.split('');
/** Distância (px) em que o olhar já está no máximo — proporcional ao personagem */
const lookReach = (size: number) => Math.max(80, size * 1.6);
/** Depois de o mouse sair da janela, os olhos voltam ao centro após este tempo */
const LOOK_RESET_AFTER_LEAVE = 1500;
/** Mouse mexido há menos que isso: os olhos seguem o cursor mesmo durante animações */
const TRACKING_WINDOW = 1500;

let cursorPollWarned = false;

interface Behavior {
  kind: IdleBehavior;
  start: number;
  dur: number;
  targetX?: number;
  /** Disparado pelo próprio Lumo (ex.: espreguiçar ao acordar); ignora o timer de 10 s */
  forced?: boolean;
  fired?: boolean;
  landed?: boolean;
}

const BEHAVIOR_DURATION: Record<IdleBehavior, number> = {
  wander: 6000,
  lookAround: 2600,
  hop: 900,
  stretch: 1800,
  wiggle: 1200,
  wink: 700,
  yawn: 2600,
  glitch: 700,
};

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

function pickBehavior(roam: number, idleFor: number): IdleBehavior {
  // Os pesos vêm da personalidade da paleta (theme/palettes.ts)
  const w = getPalette().motion.idle;
  const table: [IdleBehavior, number][] = [
    ['wander', roam > 6 ? (w.wander ?? 4) : 0],
    ['lookAround', w.lookAround ?? 3],
    ['hop', w.hop ?? 2],
    ['stretch', w.stretch ?? 1.5],
    ['wiggle', w.wiggle ?? 1.5],
    ['wink', w.wink ?? 1.5],
    ['yawn', (idleFor > 40_000 ? 2 : 0.6) * (w.yawn ?? 1)],
    ['glitch', w.glitch ?? 0],
  ];
  const total = table.reduce((s, [, x]) => s + x, 0);
  let r = Math.random() * total;
  for (const [kind, x] of table) {
    r -= x;
    if (r <= 0) return kind;
  }
  return 'lookAround';
}

export const CharacterCanvas: React.FC<CharacterCanvasProps> = ({
  emotion = 'idle',
  size = 72,
  roam = 0,
  globalCursor = false,
  onGlobalCursorBroken,
  interactive = true,
  onClick,
  lookAt = null,
  className = '',
}) => {
  const outerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Props mais recentes lidas pelo loop (o loop nunca é recriado)
  const propsRef = useRef({ emotion, size, roam });
  propsRef.current = { emotion, size, roam };

  // Alvo externo do olhar (o mousemove não chega durante um arraste do sistema)
  useEffect(() => {
    if (lookAt) lookRef.current(lookAt.x, lookAt.y);
  }, [lookAt?.x, lookAt?.y]); // eslint-disable-line react-hooks/exhaustive-deps

  const A = useRef({
    // olhar
    lookX: 0, lookY: 0, eyeX: 0, eyeY: 0,
    // corpo
    scaleX: 1, scaleY: 1, vsx: 0, vsy: 0,
    offsetY: 0, rotation: 0, shake: 0, mouth: 0,
    // andar
    x: 0, facing: 1 as 1 | -1, hopPhase: 0, appliedX: NaN,
    // olhos
    eyeStyle: 'normal' as EyeStyle, switchStart: -1, nextBlink: 0, blinkStart: -1, doubleBlink: false,
    // reações e estados
    override: null as null | { emotion: CharacterEmotion; until: number },
    behavior: null as Behavior | null,
    nextBehaviorAt: 0,
    lastInteraction: performance.now(),
    depth: 0, yaw: 0, pitch: 0,
    lastPresence: performance.now(),
    asleep: false,
    clicks: [] as number[],
    pet: 0, lastPetAt: 0, petCooldown: 0,
    lastCurious: 0,
    lastCursor: { x: NaN, y: NaN, t: 0 },
    lastCursorMove: 0,
    leftAt: 0,
    particles: [] as Particle[],
    nextParticle: 0,
    glitchUntil: 0,
    lastPalette: '',
    lastTime: performance.now(),
  });

  const react = (e: CharacterEmotion, ms: number) => {
    A.current.override = { emotion: e, until: performance.now() + ms };
  };

  const markInteraction = () => {
    const a = A.current;
    const now = performance.now();
    a.lastInteraction = now;
    a.lastPresence = now;
    a.nextBehaviorAt = 0;
    if (a.behavior) a.behavior = null;
    if (a.asleep) wake(now);
  };

  const wake = (now: number) => {
    const a = A.current;
    a.asleep = false;
    a.override = { emotion: 'surprised', until: now + 600 };
    a.behavior = { kind: 'stretch', start: now + 650, dur: BEHAVIOR_DURATION.stretch, forced: true };
    sound.playWake();
  };

  const sq = (v: number) => 1 + (v - 1) * getPalette().motion.squash;

  // ---- clique: squash, surpresa, raiva ------------------------------------------
  const handleClick = (e: React.MouseEvent) => {
    if (!interactive) return;
    e.stopPropagation();
    const a = A.current;
    const now = performance.now();
    markInteraction();
    a.clicks = a.clicks.filter((t) => now - t < 2000);
    a.clicks.push(now);
    const burst = a.clicks.length;

    if (burst >= 8) {
      sound.playAngry();
      react('furious', 6000);
      a.shake = 12;
      a.scaleX = sq(1.3); a.scaleY = sq(0.8);
      a.glitchUntil = performance.now() + 600;
      a.clicks = [];
    } else if (burst >= 5) {
      sound.playAngry();
      react('angry', 3500);
      a.shake = 8;
      a.scaleX = sq(1.2); a.scaleY = sq(0.84);
      a.glitchUntil = performance.now() + 350;
    } else {
      sound.playPop();
      // Squash: a mola devolve; a intensidade vem da personalidade (profissional = quase rígido)
      a.scaleX = sq(1.28); a.scaleY = sq(0.74);
      a.vsx = 0; a.vsy = 0;
      react('surprised', 450);
    }
    onClick?.(burst);
  };

  // ---- passar o mouse "fazendo carinho" ----------------------------------------
  const handlePointerMove = (e: React.PointerEvent) => {
    if (!interactive) return;
    const a = A.current;
    const now = performance.now();
    markInteraction();
    if (e.buttons !== 0) return; // arrastando, não é carinho
    // o "carinho" esvazia se o mouse parar
    a.pet = a.pet * Math.exp(-(now - a.lastPetAt) / 600) + Math.abs(e.movementX) + Math.abs(e.movementY);
    a.lastPetAt = now;
    const s = propsRef.current.size;
    if (a.pet > s * 5 && now > a.petCooldown && propsRef.current.emotion === 'idle') {
      a.pet = 0;
      a.petCooldown = now + 5000;
      react('love', 2600);
      sound.playLove();
    }
  };

  // ---- olhar segue o cursor ------------------------------------------------------
  const lookRef = useRef<(x: number, y: number) => void>(() => {});
  const lastGlobal = useRef({ x: NaN, y: NaN, t: 0 });
  const globalAlive = useRef(false);
  const brokenRef = useRef(onGlobalCursorBroken);
  brokenRef.current = onGlobalCursorBroken;

  // mousemove local: sempre ligado (é a fonte confiável sobre a janela)
  useEffect(() => {
    const look = (clientX: number, clientY: number) => {
      const a = A.current;
      const now = performance.now();
      const prev = a.lastCursor;
      const moved = Number.isNaN(prev.x) || Math.hypot(clientX - prev.x, clientY - prev.y) > 2;
      if (!moved) return;
      const speed = Number.isNaN(prev.x) ? 0 : Math.hypot(clientX - prev.x, clientY - prev.y) / Math.max(1, now - prev.t);
      a.lastCursor = { x: clientX, y: clientY, t: now };
      // presença (sono), nunca "interação com o Lumo": o idle de 10 s continua valendo
      a.lastPresence = now;
      a.lastCursorMove = now;
      a.leftAt = 0;
      if (a.asleep) wake(now);

      const canvas = canvasRef.current;
      if (!canvas) return;
      const r = canvas.getBoundingClientRect();
      const { size: S, emotion: em } = propsRef.current;
      const c = bodyCenter(S);
      const dx = clientX - (r.left + c.x);
      const dy = clientY - (r.top + c.y);
      const dist = Math.hypot(dx, dy);
      const reach = Math.min(dist / lookReach(S), 1) * bodySize(S) * 0.14;
      const ang = Math.atan2(dy, dx);
      a.lookX = Math.cos(ang) * reach;
      a.lookY = Math.sin(ang) * reach;

      // Mouse passando rápido perto: fica curioso (com folga entre reações)
      if (dist < S * 3.5 && speed > 3.6 && em === 'idle' && !a.override && now - a.lastCurious > 4000) {
        a.lastCurious = now;
        sound.playCurious();
        react('curious', 2200);
      }
    };
    lookRef.current = look;

    let mismatches = 0;
    let prevLocal = { x: NaN, y: NaN, t: 0 };
    const onMove = (e: MouseEvent) => {
      // Valida o cursor global: amostra recente muito longe do mouse real = coordenadas
      // erradas. Só com o mouse lento — rápido, o atraso do poll (50 ms) já explicaria.
      const now = performance.now();
      const localSpeed = Math.hypot(e.clientX - prevLocal.x, e.clientY - prevLocal.y) / Math.max(1, now - prevLocal.t);
      prevLocal = { x: e.clientX, y: e.clientY, t: now };
      const g = lastGlobal.current;
      if (globalAlive.current && now - g.t < 150 && localSpeed < 0.3) {
        const off = Math.hypot(e.clientX - g.x, e.clientY - g.y);
        mismatches = off > GLOBAL_MISMATCH_PX ? mismatches + 1 : 0;
        if (mismatches >= GLOBAL_MISMATCH_LIMIT) {
          globalAlive.current = false;
          console.warn('[Lumo] cursor global divergente do mouse real; voltando para "só Lumo".');
          brokenRef.current?.();
        }
      }
      look(e.clientX, e.clientY);
    };
    // Saiu da janela sem cursor global: depois de um tempo os olhos voltam ao centro
    // (nunca ficam presos olhando um canto)
    const onLeave = (e: MouseEvent) => {
      if (!e.relatedTarget && !globalAlive.current) A.current.leftAt = performance.now();
    };
    const onKey = () => {
      const a = A.current;
      a.lastPresence = performance.now();
      if (a.asleep) wake(a.lastPresence);
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    document.addEventListener('mouseout', onLeave);
    window.addEventListener('keydown', onKey, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseout', onLeave);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Poll global (posição já convertida para a janela pelo Rust) — só com a opção ligada
  useEffect(() => {
    if (!globalCursor) {
      globalAlive.current = false;
      return;
    }
    globalAlive.current = true;
    let busy = false;
    const poll = window.setInterval(async () => {
      if (busy || !globalAlive.current) return;
      busy = true;
      try {
        const pos = await tryInvoke<[number, number]>('get_cursor_in_window');
        if (!pos) {
          if (!cursorPollWarned) {
            cursorPollWarned = true;
            console.warn('[Lumo] cursor global indisponível; usando só o mousemove local.');
          }
          globalAlive.current = false;
          window.clearInterval(poll);
          return;
        }
        lastGlobal.current = { x: pos[0], y: pos[1], t: performance.now() };
        lookRef.current(pos[0], pos[1]);
      } finally {
        busy = false;
      }
    }, CURSOR_POLL_MS);
    return () => {
      globalAlive.current = false;
      window.clearInterval(poll);
    };
  }, [globalCursor]);

  // ---- loop de animação (60 fps, criado uma única vez) --------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;

    const spawn = (p: Omit<Particle, 'born'>, now: number) => {
      const list = A.current.particles;
      list.push({ ...p, born: now });
      if (list.length > 30) list.shift();
    };

    const frame = (now: number) => {
      const a = A.current;
      const { emotion: appEmotion, size: S, roam: R0 } = propsRef.current;
      const R = reducedMotion() ? 0 : R0;
      const dt = Math.min((now - a.lastTime) / 1000, 0.1);
      a.lastTime = now;
      const bw = bodySize(S);
      const c = bodyCenter(S);
      const pal = getPalette();
      // "Reduzir movimento" do sistema: o Lumo fica quase parado (sem andar, sem glitch)
      const calm = reducedMotion();
      const M = calm ? { ...pal.motion, lift: pal.motion.lift * 0.3, squash: pal.motion.squash * 0.3, glitch: 0 } : pal.motion;
      // Trocou de paleta: "recalibra" — um pico de glitch/piscada marca a mudança de personalidade
      if (a.lastPalette !== pal.id) {
        if (a.lastPalette) {
          a.glitchUntil = now + (M.glitch > 0.3 ? 700 : 260);
          a.blinkStart = now;
          a.doubleBlink = true;
        }
        a.lastPalette = pal.id;
      }

      // -- emoção efetiva ---------------------------------------------------------
      if (a.override && now >= a.override.until) a.override = null;
      if (appEmotion !== 'idle') a.asleep = false;
      else if (!a.asleep && !a.override && now - a.lastPresence > SLEEP_AFTER) {
        a.asleep = true;
        a.behavior = null;
        sound.playSigh();
      }
      let em: CharacterEmotion = a.override?.emotion ?? appEmotion;
      if (em === 'idle' && a.asleep) em = 'sleepy';

      // -- comportamentos ociosos -------------------------------------------------
      const idleFor = now - a.lastInteraction;
      const canBehave = em === 'idle' && idleFor > IDLE_BEHAVIOR_AFTER;
      if (a.behavior && !a.behavior.forced && !canBehave) a.behavior = null;
      if (a.behavior?.forced && appEmotion !== 'idle') a.behavior = null;
      if (canBehave && !a.behavior && now >= a.nextBehaviorAt) {
        const kind = pickBehavior(R, idleFor);
        const b: Behavior = { kind, start: now, dur: BEHAVIOR_DURATION[kind] };
        if (kind === 'wander') {
          let t = (Math.random() * 2 - 1) * R;
          if (Math.abs(t - a.x) < R * 0.3) t = a.x > 0 ? -R * (0.4 + Math.random() * 0.6) : R * (0.4 + Math.random() * 0.6);
          b.targetX = t;
        }
        a.behavior = b;
      }

      if (a.leftAt && now - a.leftAt > LOOK_RESET_AFTER_LEAVE) {
        a.lookX = 0;
        a.lookY = 0;
      }

      // -- alvos padrão da emoção -------------------------------------------------
      let eyeStyle = EYE_FOR_EMOTION[em];
      let tEyeX = a.lookX;
      let tEyeY = a.lookY;
      let tOffsetY = 0;
      let tRot = 0;
      let tSX = 1;
      let tSY = 1;
      let tMouth = 0;
      let breathRate = 0.0024;

      switch (em) {
        case 'happy':
          tOffsetY = -Math.abs(Math.sin(now * 0.012)) * bw * 0.12;
          tRot = Math.sin(now * 0.015) * 0.06;
          break;
        case 'excited':
          tOffsetY = -Math.abs(Math.sin(now * 0.018)) * bw * 0.22;
          tRot = Math.sin(now * 0.02) * 0.08;
          if (now > a.nextParticle) {
            a.nextParticle = now + 220;
            const ang = Math.random() * Math.PI * 2;
            spawn(pal.character.particles === 'glyphs'
              ? { kind: 'glyph', ch: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], x: c.x + Math.cos(ang) * bw * 0.6, y: c.y + Math.sin(ang) * bw * 0.5, vx: 0, vy: -bw * 0.3, life: 700, size: bw * 0.13 }
              : { kind: 'cross', x: c.x + Math.cos(ang) * bw * 0.6, y: c.y + Math.sin(ang) * bw * 0.5, vx: 0, vy: -bw * 0.15, life: 700, size: bw * 0.06 }, now);
          }
          break;
        case 'angry':
        case 'furious': {
          const k = em === 'furious' ? 1.5 : 1;
          a.shake = Math.max(0, a.shake - dt * (em === 'furious' ? 1.2 : 1.8));
          tOffsetY = Math.sin(now * 0.08) * 2 * k;
          tRot = (Math.random() - 0.5) * 0.14 * k;
          if (now > a.nextParticle) {
            a.nextParticle = now + 380;
            spawn({ kind: 'dot', x: c.x + (Math.random() - 0.5) * bw * 0.6, y: c.y - bw * 0.5, vx: (Math.random() - 0.5) * bw * 0.3, vy: -bw * 0.45, life: 700, size: bw * 0.045 }, now);
          }
          break;
        }
        case 'curious':
          tRot = 0.22;
          tOffsetY = -bw * 0.05;
          break;
        case 'focus':
          tOffsetY = bw * 0.02;
          tEyeY += bw * 0.02;
          break;
        case 'eager':
          // boca bem aberta, "respirando" de ansiedade, esticado para a frente
          tMouth = 0.85 + Math.sin(now * 0.009) * 0.15;
          tSX = 1.04;
          tSY = 1.06;
          tOffsetY = Math.sin(now * 0.012) * bw * 0.03;
          break;
        case 'surprised':
          tOffsetY = -bw * 0.06;
          tSX = 0.94;
          tSY = 1.07;
          // Boca aberta ("ó!") — também é a cara de "solte o arquivo aqui"
          tMouth = 0.75 + Math.sin(now * 0.006) * 0.15;
          break;
        case 'sleepy':
          tOffsetY = bw * 0.04;
          tRot = Math.sin(now * 0.0015) * 0.05;
          tEyeX = 0;
          tEyeY = bw * 0.03;
          breathRate = 0.0012;
          if (now > a.nextParticle) {
            a.nextParticle = now + 1300;
            spawn({ kind: 'z', x: c.x + bw * 0.35, y: c.y - bw * 0.45, vx: bw * 0.25, vy: -bw * 0.45, life: 2200, size: S * 0.2 }, now);
          }
          break;
        case 'yawning':
          tMouth = 0.5 + Math.sin(now * 0.002) * 0.4;
          tSY = 1.06;
          break;
        case 'thinking': {
          const ang = now * 0.0035;
          tEyeX = Math.cos(ang) * bw * 0.07;
          tEyeY = -bw * 0.05 + Math.sin(ang) * bw * 0.03;
          tOffsetY = Math.sin(now * 0.005) * bw * 0.03;
          break;
        }
        case 'love':
          tOffsetY = -Math.abs(Math.sin(now * 0.008)) * bw * 0.07;
          tRot = Math.sin(now * 0.006) * 0.08;
          if (now > a.nextParticle) {
            a.nextParticle = now + 420;
            spawn({ kind: 'ring', x: c.x + (Math.random() - 0.5) * bw * 0.5, y: c.y - bw * 0.35, vx: 0, vy: -bw * 0.25, life: 1300, size: bw * 0.1 }, now);
          }
          break;
        case 'dizzy':
          tRot = Math.sin(now * 0.01) * 0.16;
          tOffsetY = Math.sin(now * 0.02) * bw * 0.02;
          break;
      }

      // -- efeitos do comportamento ativo -----------------------------------------
      const b = a.behavior;
      if (b && now >= b.start) {
        const e = now - b.start;
        const p = clamp(e / b.dur, 0, 1);
        let done = p >= 1;
        if (!b.fired) {
          b.fired = true;
          if (b.kind === 'hop') sound.playHop();
          if (b.kind === 'yawn') sound.playYawn();
        }
        switch (b.kind) {
          case 'wander': {
            const target = clamp(b.targetX ?? 0, -R, R);
            const dx = target - a.x;
            const dir = (Math.sign(dx) || a.facing) as 1 | -1;
            a.facing = dir;
            const step = bw * 1.3 * dt;
            a.x += dir * Math.min(step, Math.abs(dx));
            const prevSin = Math.sin(a.hopPhase);
            a.hopPhase += dt * 11;
            const sin = Math.sin(a.hopPhase);
            tOffsetY = -Math.abs(sin) * bw * 0.1;
            tRot = dir * 0.08;
            tEyeX = dir * bw * 0.1;
            tEyeY = 0;
            if (Math.sign(prevSin) !== Math.sign(sin)) {
              // cada "passo" toca o chão: pequeno squash
              a.vsx += 1.2;
              a.vsy -= 1.2;
            }
            if (Math.abs(dx) < 0.5) done = true;
            break;
          }
          case 'lookAround': {
            // esquerda → centro → direita → cima → centro
            const look = bw * 0.13;
            if (p < 0.25) { tEyeX = -look; tEyeY = 0; tRot = -0.05; }
            else if (p < 0.35) { tEyeX = 0; tEyeY = 0; }
            else if (p < 0.65) { tEyeX = look; tEyeY = 0; tRot = 0.05; }
            else if (p < 0.8) { tEyeX = 0; tEyeY = -bw * 0.08; }
            else { tEyeX = 0; tEyeY = 0; }
            break;
          }
          case 'hop': {
            if (p < 0.15) { tSX = 1.15; tSY = 0.85; }
            else if (p < 0.65) {
              const q = (p - 0.15) / 0.5;
              tOffsetY = -Math.sin(q * Math.PI) * bw * 0.32;
              tSX = 0.9; tSY = 1.12;
              eyeStyle = 'happy';
            } else {
              if (!b.landed) {
                b.landed = true;
                a.scaleX = sq(1.22); a.scaleY = sq(0.8);
                for (const side of [-1, 1]) {
                  spawn({ kind: 'dot', x: c.x + side * bw * 0.45, y: c.y + bw * 0.48, vx: side * bw * 0.4, vy: -bw * 0.08, life: 400, size: bw * 0.04 }, now);
                }
              }
            }
            break;
          }
          case 'stretch': {
            const k = p < 0.6 ? ease(p / 0.6) : 1 - ease((p - 0.6) / 0.4);
            tSY = 1 + 0.18 * k;
            tSX = 1 - 0.12 * k;
            tOffsetY = -bw * 0.04 * k;
            if (k > 0.3) eyeStyle = 'happy';
            tMouth = k > 0.5 ? (k - 0.5) * 0.8 : 0;
            break;
          }
          case 'wiggle':
            tRot = Math.sin(e * 0.025) * 0.18 * (1 - p);
            break;
          case 'wink':
            eyeStyle = 'wink';
            tRot = 0.08;
            break;
          case 'glitch':
            a.glitchUntil = Math.max(a.glitchUntil, now + 120);
            tEyeX = (Math.random() - 0.5) * bw * 0.08;
            break;
          case 'yawn': {
            const k = Math.sin(p * Math.PI);
            eyeStyle = 'sleepy';
            tMouth = k;
            tSY = 1 + 0.08 * k;
            tSX = 1 - 0.04 * k;
            tEyeX = 0;
            tEyeY = 0;
            break;
          }
        }
        if (done || e > b.dur + 4000) {
          a.behavior = null;
          a.nextBehaviorAt = now + 1500 + Math.random() * 3500;
        }
      }

      // Personalidade de movimento: o desenho animado (squash, pulos, balanço) vira
      // gesto contido nas paletas profissionais e seco nas "terminal"
      tOffsetY *= M.lift;
      tRot *= 0.35 + M.squash * 0.65;
      tSX = 1 + (tSX - 1) * M.squash;
      tSY = 1 + (tSY - 1) * M.squash;

      // Mouse se mexendo: o olhar acompanha o cursor mesmo durante animações
      // (só 'thinking' e o sono têm olhar próprio)
      if (now - a.lastCursorMove < TRACKING_WINDOW && em !== 'thinking' && em !== 'sleepy') {
        tEyeX = a.lookX;
        tEyeY = a.lookY + (em === 'focus' ? bw * 0.02 : 0);
      }

      // -- olhos: piscar e troca de formato ---------------------------------------
      let openness = 1;
      if (eyeStyle !== a.eyeStyle && a.switchStart < 0) a.switchStart = now;
      if (a.switchStart >= 0) {
        const sw = now - a.switchStart;
        if (sw < 70) openness = 1 - sw / 70;
        else {
          a.eyeStyle = eyeStyle;
          openness = Math.min(1, (sw - 70) / 90);
          if (sw >= 160) a.switchStart = -1;
        }
      } else if (eyeStyle === 'normal' || eyeStyle === 'focus' || eyeStyle === 'curious') {
        if (a.blinkStart < 0 && now >= a.nextBlink) {
          a.blinkStart = now;
          a.doubleBlink = Math.random() < 0.2;
        }
        if (a.blinkStart >= 0) {
          const bt = now - a.blinkStart;
          const total = a.doubleBlink ? 340 : 150;
          if (bt >= total) {
            a.blinkStart = -1;
            a.nextBlink = now + 2200 + Math.random() * 3200;
          } else {
            openness = 1 - Math.abs(Math.sin(((bt % 170) / 150) * Math.PI));
          }
        }
      }

      // -- integração -------------------------------------------------------------
      const k = (rate: number) => Math.min(1, dt * rate);
      a.eyeX += (tEyeX - a.eyeX) * k(14);
      a.eyeY += (tEyeY - a.eyeY) * k(14);
      a.offsetY += (tOffsetY - a.offsetY) * k(14);
      a.rotation += (tRot - a.rotation) * k(12);
      a.mouth += (tMouth - a.mouth) * k(8);
      if (em !== 'angry' && em !== 'furious') a.shake = Math.max(0, a.shake - dt * 20);

      const breath = Math.sin(now * breathRate);
      const sdt = Math.min(dt, 1 / 30);
      const damp = 2 * Math.sqrt(260) * M.damping; // ζ = 0,46 era "gelatina"; perto de 1 não balança
      a.vsx += ((tSX * (1 - breath * 0.01) - a.scaleX) * 260 - a.vsx * damp) * sdt;
      a.vsy += ((tSY * (1 + breath * 0.016) - a.scaleY) * 260 - a.vsy * damp) * sdt;
      a.scaleX += a.vsx * sdt;
      a.scaleY += a.vsy * sdt;

      // Andar: limita ao espaço disponível (a janela pode ter encolhido)
      a.x = clamp(a.x, -R, R);
      const outer = outerRef.current;
      if (outer && (Number.isNaN(a.appliedX) || Math.abs(a.x - a.appliedX) > 0.05)) {
        a.appliedX = a.x;
        outer.style.transform = `translate3d(${a.x.toFixed(2)}px,0,0)`;
      }

      // Paletas "terminal": de vez em quando sobe um caractere do corpo
      if (pal.character.particles === 'glyphs' && em === 'idle' && now > a.nextParticle) {
        a.nextParticle = now + 1800 + Math.random() * 1800;
        a.particles.push({ kind: 'glyph', ch: GLYPHS[Math.floor(Math.random() * GLYPHS.length)], x: c.x + (Math.random() - 0.5) * bw * 0.7, y: c.y - bw * 0.45, vx: 0, vy: -bw * 0.35, born: now, life: 1500, size: bw * 0.12 });
      }

      // Partículas
      a.particles = a.particles.filter((pt) => now - pt.born < pt.life);
      for (const pt of a.particles) {
        pt.x += pt.vx * dt;
        pt.y += pt.vy * dt;
      }

      // -- 2D ↔ 3D (estilo Coucou) -------------------------------------------------
      // Calmo = rosto chapado de frente (2D). Mexendo o mouse por perto, arquivo
      // chegando, comemorando ou curioso = a cabeça "vira" de verdade (yaw/pitch).
      const lively =
        now - a.lastCursorMove < 2500 ||
        em === 'eager' || em === 'excited' || em === 'curious' || em === 'surprised' || em === 'love' ||
        a.behavior?.kind === 'lookAround' || a.behavior?.kind === 'wander';
      a.depth += ((lively ? 1 : 0) - a.depth) * (lively ? 0.08 : 0.025);
      const reach = bw * 0.14;
      const yawT = Math.max(-1, Math.min(1, a.eyeX / reach)) * 0.7 * a.depth;
      const pitchT = Math.max(-1, Math.min(1, a.eyeY / reach)) * 0.45 * a.depth;
      a.yaw += (yawT - a.yaw) * 0.12;
      a.pitch += (pitchT - a.pitch) * 0.12;

      // -- desenho ----------------------------------------------------------------
      const dpr = window.devicePixelRatio || 1;
      const px = Math.round(S * dpr);
      if (canvas.width !== px || canvas.height !== px) {
        canvas.width = px;
        canvas.height = px;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawFrame(ctx, {
        size: S,
        time: now,
        emotion: em,
        eyeStyle: a.eyeStyle,
        openness,
        eyeX: a.eyeX,
        eyeY: a.eyeY,
        offsetY: a.offsetY,
        rotation: a.rotation,
        scaleX: a.scaleX,
        scaleY: a.scaleY,
        shakeX: a.shake > 0 ? (Math.random() - 0.5) * a.shake * 2 : 0,
        mouth: a.mouth,
        yaw: a.yaw,
        pitch: a.pitch,
        depth: a.depth,
        particles: a.particles,
        palette: pal,
        realistic: getLook() === 'realista',
        glitch: Math.max(
          now < a.glitchUntil ? 0.35 + M.glitch * 0.65 : 0,
          em === 'dizzy' ? 0.3 + M.glitch * 0.5 : 0,
          // pico espontâneo raro nas paletas com glitch
          M.glitch > 0 && Math.floor(now / 1000) % 9 === 0 && now % 1000 < 90 ? M.glitch * 0.6 : 0
        ),
        dpr,
      });

      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div
      ref={outerRef}
      onClick={handleClick}
      onPointerDown={interactive ? markInteraction : undefined}
      onPointerMove={handlePointerMove}
      data-tauri-drag-region="false"
      className={`relative inline-flex items-center justify-center select-none ${interactive ? 'cursor-pointer' : ''} ${className}`}
      style={{ width: size, height: size, willChange: 'transform', pointerEvents: 'auto' }}
    >
      <canvas ref={canvasRef} style={{ width: size, height: size, display: 'block' }} />
    </div>
  );
};
