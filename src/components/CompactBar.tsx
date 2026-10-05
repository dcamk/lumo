import { AlertTriangle, Bell, Mail } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { CharacterCanvas, type CharacterEmotion } from '../character/CharacterCanvas';
import { SpringDragCharacter, type DragEndInfo } from '../character/SpringDragCharacter';
import { Glow } from './Glow';
import { useElementSize } from '../hooks/useElementSize';
import { compactLayout } from '../lib/layout';
import { badgePop, noticeIn } from '../lib/motion';

/** Aviso temporário na pílula (a janela alarga para mostrá-lo) */
export interface Notice {
  id: string;
  kind: 'mail' | 'reminder' | 'system';
  title: string;
  text: string;
  /** Clique no aviso (ex.: abrir o e-mail) */
  action?: () => void;
}

const NOTICE_ICON = { mail: Mail, reminder: Bell, system: AlertTriangle };

interface Props {
  emotion: CharacterEmotion;
  lumoScale: number;
  globalCursor: boolean;
  onGlobalCursorBroken: () => void;
  notice: Notice | null;
  onNoticeDismiss: () => void;
  /** E-mails não lidos (0 = sem badge) */
  badge: number;
  onCharacterClick: (burst: number) => void;
  onDragStart: () => void;
  onDragEnd: (info: DragEndInfo) => void;
}

/** Estado 1: pílula preta no topo da tela, só com o Lumo (e avisos rápidos). */
export function CompactBar({
  emotion,
  lumoScale,
  globalCursor,
  onGlobalCursorBroken,
  notice,
  onNoticeDismiss,
  badge,
  onCharacterClick,
  onDragStart,
  onDragEnd,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const noticeRef = useRef<HTMLButtonElement | null>(null);
  const badgeRef = useRef<HTMLSpanElement | null>(null);
  const { width, height } = useElementSize(panelRef);

  // Tamanho vem do slider (a janela nativa cresce junto); a folga evita encostar nas bordas
  const size = Math.max(28, Math.min(height - 6, compactLayout(lumoScale).char));
  const roam = notice ? 0 : Math.max(0, (width - size) / 2 - 8);

  useEffect(() => noticeIn(noticeRef.current), [notice?.id]);
  useEffect(() => badgePop(badgeRef.current), [badge]);

  const Icon = notice ? NOTICE_ICON[notice.kind] : null;

  return (
    <div
      ref={panelRef}
      data-tauri-drag-region
      className={`relative w-full h-full flex items-center overflow-hidden ${
        notice ? 'justify-start gap-3 pl-3 pr-4' : 'justify-center'
      }`}
    >
      {height > 0 && (
        <div data-anim="char" className="relative isolate shrink-0">
          <Glow />
          <SpringDragCharacter boundsRef={panelRef} onDragStart={onDragStart} onDragEnd={onDragEnd}>
            <CharacterCanvas
              emotion={emotion}
              size={size}
              roam={roam}
              globalCursor={globalCursor}
              onGlobalCursorBroken={onGlobalCursorBroken}
              onClick={onCharacterClick}
            />
          </SpringDragCharacter>
          {badge > 0 && !notice && (
            <span
              ref={badgeRef}
              title={`${badge} e-mail(s) não lido(s)`}
              className="lumo-pill absolute top-0 right-0 min-w-4 h-4 px-1 rounded-full text-[9px] font-bold leading-4 text-white text-center pointer-events-none"
            >
              {badge > 99 ? '99+' : badge}
            </span>
          )}
        </div>
      )}

      {notice && Icon && (
        <button
          ref={noticeRef}
          key={notice.id}
          type="button"
          role="status"
          onClick={() => {
            notice.action?.();
            onNoticeDismiss();
          }}
          title={notice.action ? 'Abrir' : 'Fechar'}
          className="min-w-0 flex-1 flex items-center gap-2 text-left rounded-xl px-1 py-0.5 hover:bg-white/[0.06] transition-colors"
        >
          <Icon className={`w-3.5 h-3.5 shrink-0 ${notice.kind === 'system' ? 'text-amber-400' : 'text-slate-300'}`} />
          <span className="min-w-0">
            <span className="block text-[11px] text-slate-400 truncate">{notice.title}</span>
            <span className="block text-xs font-medium text-white truncate">{notice.text}</span>
          </span>
        </button>
      )}
    </div>
  );
}
