import { useEffect, useRef } from 'react';
import { isTauri } from '../lib/tauri';

interface Handlers {
  /** Arquivo entrou na janela (ainda segurado) */
  onEnter: () => void;
  /** O arquivo segurado se moveu (coordenadas da página, como clientX/Y) */
  onOver?: (pos: { x: number; y: number }) => void;
  /** Saiu sem soltar / cancelou */
  onLeave: () => void;
  /** Soltou: caminhos reais no disco */
  onDrop: (paths: string[]) => void;
}

/**
 * Arrastar arquivos do gerenciador de arquivos para o Lumo, em qualquer modo/aba.
 * No app nativo o Tauri entrega os caminhos reais (o HTML5 só daria o conteúdo).
 */
export function useFileDrop(handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;

  useEffect(() => {
    if (!isTauri()) return;
    let off: (() => void) | undefined;
    let alive = true;
    void import('@tauri-apps/api/webview').then(({ getCurrentWebview }) =>
      getCurrentWebview()
        .onDragDropEvent((event) => {
          const p = event.payload;
          // O Tauri manda px físicos; a página usa px lógicos
          const toPage = (pos: { x: number; y: number }) => ({ x: pos.x / devicePixelRatio, y: pos.y / devicePixelRatio });
          if (p.type === 'enter') {
            ref.current.onEnter();
            ref.current.onOver?.(toPage(p.position));
          } else if (p.type === 'over') ref.current.onOver?.(toPage(p.position));
          else if (p.type === 'leave') ref.current.onLeave();
          else if (p.type === 'drop') ref.current.onDrop(p.paths);
        })
        .then((fn) => {
          if (alive) off = fn;
          else fn();
        })
    );
    return () => {
      alive = false;
      off?.();
    };
  }, []);
}
