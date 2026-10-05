import { ExternalLink, Mail, RefreshCw } from 'lucide-react';
import { gmailLink, type GoogleControls } from '../../hooks/useGoogle';
import { timeAgo } from '../../lib/reminders';

interface Props {
  google: GoogleControls;
  onOpen: (url: string) => void;
  /** Leva para Config → Contas */
  onSetup: () => void;
}

const btn = 'shrink-0 flex items-center gap-1 px-2.5 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white text-[11px] disabled:opacity-40 transition-colors';

/** Não lidos do Gmail: lista, abrir no navegador e checar agora */
export function MailTab({ google, onOpen, onSetup }: Props) {
  const { status, messages, unread, checking, lastCheck, error } = google;

  if (!status?.connected) {
    return (
      <div className="flex-1 min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4">
        <Mail data-anim="item" className="w-6 h-6 text-slate-500" />
        <p data-anim="item" className="text-[11px] text-slate-300 max-w-[280px] leading-snug">
          Conecte sua conta Google e o Lumo avisa na pílula (e com notificação) quando chegar e-mail novo.
        </p>
        <div data-anim="item" className="flex gap-1.5">
          {status?.configured ? (
            <button type="button" disabled={google.busy} onClick={google.connect} className="lumo-pill px-3 h-7 rounded-full text-[11px] font-semibold text-white disabled:opacity-50">
              {google.busy ? 'Aguardando o navegador…' : 'Conectar Google'}
            </button>
          ) : (
            <button type="button" onClick={onSetup} className="lumo-pill px-3 h-7 rounded-full text-[11px] font-semibold text-white">
              Configurar conta Google
            </button>
          )}
        </div>
        {google.error && <p className="text-[10px] text-amber-400 max-w-[300px] truncate" title={google.error}>{google.error}</p>}
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col pt-2 overflow-hidden">
      <div data-anim="item" className="flex items-center gap-1.5 pb-1.5 shrink-0">
        <span className="text-[11px] text-slate-300">
          <span className="text-white font-semibold">{unread}</span> não lido{unread === 1 ? '' : 's'}
        </span>
        <span className="text-[10px] text-slate-600 truncate" title={status.email ?? undefined}>
          · {status.email}
        </span>
        <button type="button" onClick={google.refresh} disabled={checking} aria-label="Checar agora" title={lastCheck ? `Checado há ${timeAgo(lastCheck)}` : 'Checar agora'} className={`${btn} ml-auto px-1.5`}>
          <RefreshCw className={`w-3 h-3 ${checking ? 'animate-spin' : ''}`} />
        </button>
        <button type="button" onClick={() => onOpen(gmailLink())} className={btn}>
          Gmail <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      {error && <p className="text-[10px] text-amber-400 truncate pb-1" title={error}>{error}</p>}

      <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1 space-y-1">
        {messages.length === 0 && (
          <p data-anim="item" className="text-center text-slate-500 text-[11px] pt-6">
            Caixa de entrada em dia.
          </p>
        )}
        {messages.map((m) => (
          <button
            key={m.id}
            type="button"
            data-anim="item"
            onClick={() => onOpen(gmailLink(m))}
            className="w-full text-left px-2 py-1.5 rounded-xl bg-surface hover:bg-surface-3 transition-colors"
          >
            <span className="flex items-baseline gap-2">
              <span className="text-[11px] font-semibold text-white truncate">{m.from || 'Remetente desconhecido'}</span>
              <span className="ml-auto shrink-0 text-[10px] text-slate-500 tabular-nums">{m.date ? timeAgo(m.date) : ''}</span>
            </span>
            <span className="block text-[11px] text-slate-200 truncate">{m.subject || '(sem assunto)'}</span>
            {m.snippet && <span className="block text-[10px] text-slate-500 truncate">{m.snippet}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
