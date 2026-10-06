import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sound } from '../audio/SoundEngine';
import { overlaySize, PANEL_EXTRA_MAX, quickLayout, shellSize, type PanelExtra } from '../lib/layout';
import { bootIntro, contentIn, contentOut, shellTo } from '../lib/motion';
import { isTauri, tryInvoke } from '../lib/tauri';
import type { WindowMode } from '../types';

/** Raio dos cantos de baixo da casca em cada modo (igual ao App.tsx) */
export const SHELL_RADIUS: Record<WindowMode, number> = { compact: 24, quick: 22, drop: 28 };

/**
 * Modo da janela (pílula ↔ painel ↔ tela de soltar arquivo).
 *
 * A janela nativa é um overlay de tamanho fixo; a "casca" preta dentro dela muda de
 * tamanho com mola (anime.js). A janela é recortada no formato da casca a cada quadro
 * (XShape): fora dela o clique atravessa e nenhum rastro do WebKitGTK aparece.
 *
 * `wide` = a pílula compacta está mostrando um aviso e precisa alargar.
 * `resizing` = o usuário está puxando o canto do painel (a janela fica no tamanho máximo).
 */
export function useWindowMode(scale: number, extra: PanelExtra, wide: boolean, resizing: boolean) {
  const [mode, setMode] = useState<WindowMode>('compact');
  const shellRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const transitioning = useRef(false);
  const size = shellSize(mode, scale, extra, wide);

  // ---- recorte da janela = casca (clique + desenho), sincronizado por quadro ------------
  const lastShape = useRef('');
  const syncShape = useCallback(() => {
    const el = shellRef.current;
    if (!el || !isTauri()) return;
    const r = el.getBoundingClientRect();
    const shape = {
      x: Math.max(0, Math.floor(r.left) - 1),
      y: 0,
      width: Math.ceil(r.width) + 2,
      height: Math.ceil(r.bottom) + 1,
      radius: SHELL_RADIUS[modeRef.current],
    };
    const key = `${shape.x},${shape.width},${shape.height},${shape.radius}`;
    if (key === lastShape.current) return;
    lastShape.current = key;
    void tryInvoke('set_window_shape', shape);
  }, []);

  // Acompanha a casca enquanto ela anima (rAF até o prazo). A cada quadro a janela
  // inteira é repintada: o WebKitGTK só redesenha o que mudou e, quando a casca encolhe,
  // a área que voltou a ser transparente fica com o desenho antigo (os "rastros" em
  // degraus). O recorte da janela (set_window_shape) esconde isso só quando o
  // compositor o respeita; a repintura resolve em qualquer caso.
  const trackUntil = useRef(0);
  const tracking = useRef(false);
  const track = useCallback(
    (ms: number) => {
      trackUntil.current = Math.max(trackUntil.current, performance.now() + ms);
      if (tracking.current) return;
      tracking.current = true;
      let flip = false;
      const loop = () => {
        syncShape();
        flip = !flip;
        flushRepaint(flip);
        if (performance.now() < trackUntil.current) requestAnimationFrame(loop);
        else {
          tracking.current = false;
          // mais dois quadros depois do fim: limpa o que sobrou do último passo
          requestAnimationFrame(() => {
            flushRepaint(true);
            requestAnimationFrame(() => flushRepaint(false));
          });
        }
      };
      requestAnimationFrame(loop);
    },
    [syncShape]
  );

  // ---- tamanho da janela nativa: só quando escala/painel mudam (nunca no meio do morph)
  useEffect(() => {
    if (!isTauri()) return;
    const o = resizing ? overlaySize(scale, PANEL_EXTRA_MAX) : overlaySize(scale, extra);
    void tryInvoke('set_overlay_size', o);
  }, [scale, extra.w, extra.h, resizing]); // eslint-disable-line react-hooks/exhaustive-deps

  // A janela mudou de largura → recentraliza a região de cliques
  useEffect(() => {
    const onResize = () => track(200);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [track]);

  // ---- morph da casca quando o tamanho-alvo muda ------------------------------------------
  const first = useRef(true);
  const prev = useRef(size);
  useEffect(() => {
    if (first.current) return;
    prev.current = size;
    void shellTo(shellRef.current, size, resizing);
    track(resizing ? 120 : 900);
  }, [size.width, size.height]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- entrada: abertura do Lumo na primeira vez; depois, o conteúdo do novo modo
  useLayoutEffect(() => {
    if (first.current) {
      first.current = false;
      prev.current = size;
      void shellTo(shellRef.current, size, true);
      if (shellRef.current) bootIntro(shellRef.current);
      track(1800);
      return;
    }
    contentIn(contentRef.current, mode);
    track(900); // o raio dos cantos muda com o modo
  }, [mode]); // eslint-disable-line react-hooks/exhaustive-deps

  const changeMode = useCallback(async (next: WindowMode) => {
    if (transitioning.current || next === modeRef.current) return;
    transitioning.current = true;
    if (next !== 'drop') sound.playPop();
    await contentOut(contentRef.current);
    setMode(next);
    transitioning.current = false;
  }, []);

  return { mode, modeRef, shellRef, contentRef, changeMode, size };
}

/**
 * Camada invisível do tamanho da janela: alternar a cor dela (quase transparente ↔
 * transparente) obriga o WebKit a redesenhar a janela toda, apagando os rastros.
 */
let flushEl: HTMLDivElement | null = null;
function flushRepaint(on: boolean) {
  if (typeof document === 'undefined') return;
  if (!flushEl) {
    flushEl = document.createElement('div');
    flushEl.setAttribute('aria-hidden', 'true');
    flushEl.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;background:transparent;';
    document.body.appendChild(flushEl);
  }
  flushEl.style.background = on ? 'rgba(0,0,0,0.004)' : 'transparent';
}

/** Tamanho máximo do painel ao puxar o canto (para limitar o arraste) */
export const maxPanel = (scale: number) => quickLayout(scale, PANEL_EXTRA_MAX);
