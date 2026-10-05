import { ChevronUp } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { CharacterCanvas, type CharacterEmotion } from '../character/CharacterCanvas';
import { SpringDragCharacter, type DragEndInfo } from '../character/SpringDragCharacter';
import { Glow } from './Glow';
import { useElementSize } from '../hooks/useElementSize';
import { PILLS_HEIGHT, quickLayout } from '../lib/layout';
import { press, tabIn, titleIn } from '../lib/motion';
import type { PanelTab } from '../types';

const NAV: { key: PanelTab; label: string }[] = [
  { key: 'tasks', label: 'Tarefas' },
  { key: 'focus', label: 'Foco' },
  { key: 'chat', label: 'IA' },
  { key: 'mail', label: 'E-mail' },
  { key: 'linux', label: 'Sistema' },
  { key: 'terminal', label: 'Terminal' },
  { key: 'style', label: 'Estilo' },
  { key: 'settings', label: 'Config' },
];

const TITLES: Record<PanelTab, string> = {
  tasks: 'Tarefas',
  focus: 'Foco',
  chat: 'Assistente',
  mail: 'Gmail',
  linux: 'Sistema',
  terminal: 'Terminal',
  style: 'Estilo',
  settings: 'Config',
};

interface Props {
  tab: PanelTab;
  onTabChange: (t: PanelTab) => void;
  onCollapse: () => void;
  /** Controle extra no cabeçalho do conteúdo (ex.: páginas da Config) */
  headerAccessory?: React.ReactNode;
  /** Números nas pílulas (ex.: e-mails não lidos) */
  counts?: Partial<Record<PanelTab, number>>;
  emotion: CharacterEmotion;
  lumoScale: number;
  globalCursor: boolean;
  onGlobalCursorBroken: () => void;
  onDragStart: () => void;
  onDragEnd: (info: DragEndInfo) => void;
  /** Alça do canto (redimensionar) */
  onResizeStart?: (e: React.PointerEvent) => void;
  onResizeReset?: () => void;
  children: React.ReactNode;
}

/**
 * Estado 2: painel preto largo.
 * Coluna esquerda: pílulas de navegação 2×3 (em cima) + Lumo (embaixo, à esquerda).
 * Coluna direita: conteúdo da aba ativa.
 */
export function QuickPanel({
  tab,
  onTabChange,
  onCollapse,
  headerAccessory,
  counts,
  emotion,
  lumoScale,
  globalCursor,
  onGlobalCursorBroken,
  onDragStart,
  onDragEnd,
  onResizeStart,
  onResizeReset,
  children,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const firstTab = useRef(true);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const { height } = useElementSize(panelRef);

  // Tamanho vem do slider (lib/layout.ts — a janela cresce junto); se o usuário
  // encolher a janela, limita ao espaço abaixo das pílulas para nunca cobri-las
  const layout = quickLayout(lumoScale);
  const size = Math.max(40, Math.min(layout.char, height - PILLS_HEIGHT - 36));

  // Só o miolo troca entre abas (a entrada do painel já anima tudo na primeira vez)
  useLayoutEffect(() => titleIn(titleRef.current), [tab]);

  useLayoutEffect(() => {
    if (firstTab.current) {
      firstTab.current = false;
      return;
    }
    tabIn(bodyRef.current);
  }, [tab]);

  return (
    <div
      ref={panelRef}
      data-tauri-drag-region
      className="relative w-full h-full flex gap-3 p-3 overflow-hidden text-xs"
    >
      {/* Alça do canto: estica o painel (o tamanho fica salvo) */}
      {onResizeStart && (
        <div
          role="separator"
          aria-label="Redimensionar painel"
          title="Arraste para redimensionar · duplo clique volta ao padrão"
          onPointerDown={onResizeStart}
          onDoubleClick={onResizeReset}
          className="absolute right-0 bottom-0 w-4 h-4 cursor-nwse-resize z-10 group"
        >
          <span className="absolute right-1.5 bottom-1.5 w-2 h-2 border-r-2 border-b-2 border-white/20 group-hover:border-white/60 rounded-br-sm transition-colors" />
        </div>
      )}
      {/* Luz ambiente: vem de onde o Lumo está, na cor do humor */}
      <div className="lumo-ambient" aria-hidden />

      {/* Coluna esquerda */}
      <aside className="relative flex flex-col shrink-0" style={{ width: layout.side }}>
        <nav className="grid grid-cols-2 gap-1.5" style={{ width: 148 }} aria-label="Seções do Lumo">
          {NAV.map((item) => {
            const active = item.key === tab;
            const count = counts?.[item.key] ?? 0;
            return (
              <button
                key={item.key}
                type="button"
                data-anim="pill"
                aria-pressed={active}
                onClick={(e) => {
                  press(e.currentTarget);
                  onTabChange(item.key);
                }}
                className="lumo-nav relative h-7 rounded-full text-[11px] font-semibold"
              >
                {item.label}
                {count > 0 && (
                  <span className="absolute top-1/2 -translate-y-1/2 right-1.5 min-w-4 h-4 px-1 rounded-full bg-accent text-[var(--on-accent)] text-[9px] font-bold leading-4 ring-1 ring-black/20">
                    {count > 99 ? '99+' : count}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="mt-auto flex items-end justify-start">
          {height > 0 && (
            <div data-anim="char" className="relative isolate">
              <Glow />
              <SpringDragCharacter boundsRef={panelRef} onDragStart={onDragStart} onDragEnd={onDragEnd}>
                <CharacterCanvas
                  emotion={emotion}
                  size={size}
                  globalCursor={globalCursor}
                  onGlobalCursorBroken={onGlobalCursorBroken}
                />
              </SpringDragCharacter>
            </div>
          )}
        </div>
      </aside>

      {/* Conteúdo */}
      <main data-anim="content" className="relative flex-1 min-w-0 flex flex-col">
        <header className="flex items-center justify-between shrink-0 h-7 pb-1 border-b border-[color:var(--line)]">
          <h2 ref={titleRef} key={tab} className="lumo-title" aria-label={TITLES[tab]}>
            {[...TITLES[tab]].map((ch, i, all) => (
              <span key={i} aria-hidden style={{ ['--i' as string]: i, ['--n' as string]: all.length }}>
                {ch}
              </span>
            ))}
          </h2>
          <div className="ml-auto mr-1">{headerAccessory}</div>
          <button
            type="button"
            aria-label="Recolher"
            title="Recolher (Ctrl+Alt+L)"
            onClick={onCollapse}
            className="p-1 rounded-full text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
        </header>
        <div ref={bodyRef} key={tab} className="flex-1 min-h-0 flex flex-col">
          {children}
        </div>
      </main>
    </div>
  );
}
