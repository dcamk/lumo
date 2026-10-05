// Animações da interface com anime.js (github.com/juliangarnier/anime).
// A janela nativa é um overlay de tamanho fixo; a casca preta dentro dela muda de
// tamanho animada (morph), então nada "pula" no WebKitGTK. Os elementos são marcados
// com data-anim="…" nos componentes.
import { animate, createTimeline, spring, stagger, utils } from 'animejs';
import { getPalette } from '../theme/store';
import type { WindowMode } from '../types';

export const reducedMotion = () =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/** Perfil de movimento da paleta ativa (theme/palettes.ts): velocidade, mola, intensidade */
const P = () => getPalette().motion;

/** Duração respeitando "reduzir movimento" do sistema e a velocidade da personalidade */
const d = (ms: number) => (reducedMotion() ? 1 : Math.round(ms * P().speed));

/** Mola da interface: o "bounce" vem da personalidade (profissional ≈ 0, sem sobrepasso) */
const sp = (ms: number) => spring({ bounce: P().bounce, duration: d(ms) });

const q = (root: Element, sel: string) => Array.from(root.querySelectorAll<HTMLElement>(sel));

/** Espera uma animação terminar (o `then` do anime.js) */
const done = (a: { then: (cb: () => void) => unknown }) => new Promise<void>((r) => void a.then(() => r()));

// ---- Inicialização ------------------------------------------------------------------

/**
 * Abertura do Lumo: a pílula nasce de uma linha no topo, abre com mola contida e o
 * personagem aparece com um leve deslize; uma varredura de luz percorre a borda.
 * (Sem confete: faíscas/quiques foram trocados por luz — motion-art-direction.)
 */
export function bootIntro(view: HTMLElement, rim?: HTMLElement | null) {
  const shell = view.querySelector<HTMLElement>('[data-anim="shell"]') ?? view;
  const char = view.querySelector<HTMLElement>('[data-anim="char"]');
  if (!shell) return;
  if (reducedMotion()) {
    utils.set([shell, char].filter(Boolean) as HTMLElement[], { opacity: 1 });
    return;
  }
  utils.set(shell, { scaleX: 0.1, scaleY: 0.3, opacity: 0, transformOrigin: '50% 0%' });
  if (char) utils.set(char, { scale: 0.92, translateY: -8, opacity: 0 });

  const tl = createTimeline();
  tl.add(shell, { opacity: [0, 1], scaleY: [0.3, 1], duration: d(240), ease: 'outQuad' })
    .add(shell, { scaleX: [0.1, 1], ease: sp(600) }, '-=100');
  if (char) {
    tl.add(char, { scale: [0.92, 1], translateY: [-8, 0], opacity: [0, 1], ease: sp(560) }, '-=360');
  }
  window.setTimeout(() => rimSweep(rim ?? view.querySelector<HTMLElement>('.lumo-rim')), d(380));
}

// ---- Troca de modo: a casca preta "estica" (morph) ----------------------------------------

/** Conteúdo do modo atual sai rápido antes do morph */
export async function contentOut(content: HTMLElement | null) {
  if (!content) return;
  await done(animate(content, { opacity: 0, scale: 0.97, duration: d(110), ease: 'inQuad' }));
}

/**
 * A casca muda de tamanho com mola (pílula ↔ painel ↔ tela de soltar arquivo).
 * Como a janela nativa não muda, o WebKitGTK não deixa rastros.
 */
export function shellTo(shell: HTMLElement | null, size: { width: number; height: number }, instant = false) {
  if (!shell) return Promise.resolve();
  if (instant || reducedMotion()) {
    // direto no estilo: precisa valer já (arrastando o canto, abertura)
    utils.remove(shell);
    shell.style.width = `${size.width}px`;
    shell.style.height = `${size.height}px`;
    return Promise.resolve();
  }
  return done(animate(shell, { width: size.width, height: size.height, ease: sp(520) }));
}

/** Conteúdo do novo modo entra enquanto a casca termina de esticar */
export function contentIn(content: HTMLElement | null, mode: WindowMode) {
  if (!content) return;
  utils.set(content, { opacity: 0, scale: 0.98, transformOrigin: '50% 0%' });
  animate(content, { opacity: 1, scale: 1, delay: d(mode === 'compact' ? 120 : 170), duration: d(240), ease: 'outCubic' });

  if (mode === 'quick') {
    const pills = q(content, '[data-anim="pill"]');
    utils.set(pills, { opacity: 0, translateY: -4, scale: 0.94 });
    animate(pills, { opacity: 1, translateY: 0, scale: 1, delay: stagger(d(30), { start: d(200) }), ease: sp(460) });
  }
  const char = content.querySelector<HTMLElement>('[data-anim="char"]');
  if (char) turnIn3d(char, d(160));
}

/** Arquivo caiu: o Lumo "engole" (achata e volta) */
export function gulp(el: HTMLElement | null) {
  if (!el || reducedMotion()) return;
  const k = 0.35 + P().squash * 0.65; // contido nas paletas profissionais
  animate(el, {
    perspective: 420,
    scaleY: [1, 1 - 0.25 * k, 1 + 0.1 * k, 1],
    scaleX: [1, 1 + 0.2 * k, 1 - 0.05 * k, 1],
    rotateX: [0, 28 * k, -12 * k, 0],
    duration: d(560),
    ease: 'outQuad',
  });
}

// ---- Dentro do painel ---------------------------------------------------------------------

/** Troca de aba: os itens do miolo entram em cascata (pílulas e Lumo ficam parados) */
export function tabIn(el: HTMLElement | null) {
  if (!el) return;
  const items = q(el, '[data-anim="item"]');
  utils.set(el, { opacity: 0, scale: 0.98, transformOrigin: '50% 0%' });
  animate(el, { opacity: 1, scale: 1, duration: d(220), ease: 'outCubic' });
  if (items.length) {
    utils.set(items, { opacity: 0, translateY: 6 });
    animate(items, { opacity: 1, translateY: 0, delay: stagger(d(28), { start: d(40) }), duration: d(260), ease: 'outCubic' });
  }
}

/** Pílula de navegação apertada */
export function press(el: HTMLElement | null) {
  if (!el || reducedMotion()) return;
  animate(el, { scale: [0.96, 1], ease: sp(260) });
}

/** Item novo numa lista (tarefa, e-mail, saída de comando) */
export function itemIn(el: HTMLElement | null) {
  if (!el) return;
  utils.set(el, { opacity: 0, translateX: -8 });
  animate(el, { opacity: 1, translateX: 0, ease: sp(420) });
}

/** Item saindo de uma lista; resolve quando some */
export async function itemOut(el: HTMLElement | null) {
  if (!el) return;
  await done(animate(el, { opacity: 0, translateX: 14, scale: 0.96, duration: d(160), ease: 'inQuad' }));
}

/** Marcar tarefa como feita: o círculo estala e a linha dá um brilho */
export function checkPop(circle: HTMLElement | null, row: HTMLElement | null) {
  if (reducedMotion()) return;
  if (circle) animate(circle, { scale: [0.7, 1.08, 1], duration: d(300), ease: 'outCubic' });
  if (row) animate(row, { opacity: [0.6, 1], duration: d(260), ease: 'outQuad' });
}

/** Aviso que aparece na pílula compacta (e-mail, lembrete, sistema) */
export function noticeIn(el: HTMLElement | null) {
  if (!el) return;
  utils.set(el, { opacity: 0, translateX: -8 });
  animate(el, { opacity: 1, translateX: 0, delay: d(60), ease: sp(420) });
}

/** Badge de contagem: pulinho quando o número muda */
export function badgePop(el: HTMLElement | null) {
  if (!el || reducedMotion()) return;
  animate(el, { scale: [0.7, 1.1, 1], duration: d(320), ease: 'outCubic' });
}

/** Barras de uso (CPU/RAM…) deslizam até o novo valor */
export function meterTo(el: HTMLElement | null, pct: number) {
  if (!el) return;
  animate(el, { width: `${Math.max(0, Math.min(100, pct))}%`, duration: d(600), ease: 'outExpo' });
}

/** Timer do foco: pulso ao iniciar/parar */
export function pulse(el: HTMLElement | null) {
  if (!el || reducedMotion()) return;
  animate(el, { scale: [1, 1.05, 1], duration: d(320), ease: 'outQuad' });
}

/** Erro: balança para os lados */
export function shake(el: HTMLElement | null) {
  if (!el || reducedMotion()) return;
  animate(el, { translateX: [0, -4, 4, -2, 2, 0], duration: d(300), ease: 'linear' });
}

// ---- Luz e tipografia ------------------------------------------------------------------

/** Título da aba: letras sobem uma a uma e um brilho em gradiente atravessa o texto */
export function titleIn(el: HTMLElement | null) {
  if (!el) return;
  const letters = q(el, 'span');
  if (reducedMotion()) {
    utils.set(letters, { opacity: 1 });
    return;
  }
  const hacker = P().glitch > 0.3;
  utils.set(letters, { opacity: 0, translateY: hacker ? 0 : 4 });
  if (hacker) {
    // terminal: as letras "digitam" uma a uma, com falhas, sem deslizar
    animate(letters, { opacity: [0, 1, 0.3, 1], delay: stagger(d(40)), duration: d(220), ease: 'linear' });
    return;
  }
  animate(letters, { opacity: 1, translateY: 0, delay: stagger(d(20)), duration: d(300), ease: 'outCubic' });
  // onda de luz: cada letra acende e volta, da esquerda para a direita
  animate(letters, { filter: ['brightness(1)', 'brightness(1.5)', 'brightness(1)'], delay: stagger(d(32), { start: d(200) }), duration: d(480), ease: 'inOutSine' });
}

/** Varrida de luz pela borda de baixo da casca (aviso novo, tarefa concluída…) */
export function rimSweep(rim: HTMLElement | null) {
  if (!rim || reducedMotion()) return;
  const state = { p: -40 };
  animate(state, {
    p: 140,
    duration: 900,
    ease: 'inOutQuad',
    onUpdate: () => rim.style.setProperty('--sweep', `${state.p}%`),
  });
  animate(rim, { opacity: [1, 0.55], duration: d(1100), ease: 'outQuad' });
}

/** Reação de luz: a aura acende forte por um instante (sucesso, erro, chegada) */
export function auraFlash(root: ParentNode | null) {
  if (!root || reducedMotion()) return;
  const auras = Array.from(root.querySelectorAll<HTMLElement>('.lumo-flare'));
  if (auras.length) animate(auras, { opacity: [0.8, 0], scale: [0.85, 1.2], duration: d(800), ease: 'outCubic' });
}

// ---- Momentos 3D (o Lumo é 2D; nestes instantes ele vira "objeto") ---------------------

/** Entra virando suavemente para a frente, como um painel que se alinha a você */
export function turnIn3d(el: HTMLElement | null, delay = 0) {
  if (!el) return;
  if (reducedMotion()) {
    utils.set(el, { opacity: 1 });
    return;
  }
  utils.set(el, { perspective: 520, rotateY: -38, scale: 0.94, opacity: 0 });
  animate(el, { rotateY: 0, scale: 1, opacity: 1, delay, ease: sp(620) });
}

/**
 * Comemoração: um aceno 3D curto (inclina para os dois lados e volta). Nas paletas
 * "terminal" vira um flash de sinal em vez de movimento.
 */
export function spin3d(root: ParentNode | null) {
  if (!root || reducedMotion()) return;
  const chars = Array.from(root.querySelectorAll<HTMLElement>('[data-anim="char"]'));
  if (!chars.length) return;
  if (P().glitch > 0.3) {
    animate(chars, { opacity: [1, 0.35, 1, 0.6, 1], duration: d(380), ease: 'linear' });
    return;
  }
  animate(chars, {
    perspective: 520,
    rotateY: [0, 18, -9, 0],
    translateY: [0, -3, 0],
    duration: d(620),
    ease: 'inOutCubic',
    onComplete: () => utils.set(chars, { rotateY: 0 }),
  });
}

// ---- Troca de paleta ----------------------------------------------------------------------

/** A casca "recalibra": clarão de borda, luz do humor e varredura — marca a nova personalidade */
export function recalibrate(shell: HTMLElement | null, rim: HTMLElement | null) {
  if (!shell || reducedMotion()) return;
  shell.classList.remove('lumo-recalibrate');
  void shell.offsetWidth; // reinicia a animação CSS
  shell.classList.add('lumo-recalibrate');
  window.setTimeout(() => shell.classList.remove('lumo-recalibrate'), d(560));
  auraFlash(shell);
  rimSweep(rim);
}
