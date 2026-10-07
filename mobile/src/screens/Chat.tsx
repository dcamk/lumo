// Chat com a IA do PC. Bolhas entram com mola; comandos pedem aprovação com botões grandes.
import { Check, FilePen, Square, SendHorizontal, Terminal, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import { RichText } from '../../../src/components/RichText';
import type { ChatItem } from '../../../src/types';
import type { ChatPhase } from '../hooks/useRemoteChat';

interface Props {
  items: ChatItem[];
  phase: ChatPhase;
  send: (text: string) => void;
  approve: (id: string, ok: boolean) => void;
  stop: () => void;
  clear: () => void;
  online: boolean;
}

const SUGGESTIONS = ['Quanto espaço livre tenho no PC?', 'O que está pesando no PC agora?', 'Liste os arquivos que mandei hoje', 'Me dê uma dica de foco'];

export function Chat({ items, phase, send, approve, stop, clear, online }: Props) {
  const [text, setText] = useState('');
  const list = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const busy = phase !== 'idle';

  // Rola para o fim quando chega coisa nova
  const last = items[items.length - 1];
  const sig = `${items.length}:${last && 'text' in last ? last.text.length : 0}:${last?.kind === 'command' ? last.output.length : 0}`;
  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [sig, phase]);

  const submit = () => {
    if (!text.trim() || busy) return;
    send(text);
    setText('');
    input.current?.focus();
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between px-4 pb-2">
        <h2 className="text-xl font-bold">Chat</h2>
        <button type="button" className="m-btn min-h-9 px-3 text-[13px]" onClick={clear} disabled={busy} aria-label="Nova conversa">
          <Trash2 className="h-4 w-4" /> Nova
        </button>
      </div>

      <div ref={list} className="m-scroll flex min-h-0 flex-1 flex-col gap-2.5 px-4 pb-3" aria-live="polite">
        <AnimatePresence initial={false}>
          {items.map((m) => (
            <motion.div
              key={m.id}
              layout="position"
              initial={{ opacity: 0, y: 14, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9 }}
              transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              className={m.kind === 'user' ? 'self-end' : 'self-start'}
              style={{ maxWidth: m.kind === 'command' || m.kind === 'write' ? '100%' : '88%', width: m.kind === 'command' || m.kind === 'write' ? '100%' : undefined }}
            >
              <Bubble item={m} approve={approve} />
            </motion.div>
          ))}
        </AnimatePresence>
        {phase === 'thinking' && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="m-dots self-start px-3 py-2" aria-label="Pensando">
            <span />
            <span />
            <span />
          </motion.div>
        )}
        {items.length <= 1 && !busy && (
          <div className="mt-2 flex flex-wrap gap-2">
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" className="m-btn min-h-9 px-3 text-[13px] font-medium" onClick={() => send(s)} disabled={!online}>
                {s}
              </button>
            ))}
          </div>
        )}
      </div>

      <form
        className="flex items-end gap-2 border-t border-line px-3 pt-2"
        style={{ paddingBottom: 8 }}
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          ref={input}
          rows={1}
          className="m-input max-h-36 resize-none"
          placeholder={online ? 'Mensagem para o Lumo do PC…' : 'PC fora de alcance'}
          value={text}
          enterKeyHint="send"
          onChange={(e) => {
            setText(e.target.value);
            e.target.style.height = 'auto';
            e.target.style.height = `${Math.min(144, e.target.scrollHeight)}px`;
          }}
          onKeyDown={(e) => {
            // Teclado físico (tablet): Enter envia, Shift+Enter quebra a linha
            if (e.key === 'Enter' && !e.shiftKey && !('ontouchstart' in window)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {busy ? (
          <button type="button" className="m-btn m-btn-danger h-[46px] w-[46px] shrink-0 p-0" onClick={stop} aria-label="Parar">
            <Square className="h-4 w-4" />
          </button>
        ) : (
          <motion.button whileTap={{ scale: 0.85, rotate: -12 }} type="submit" className="m-btn m-btn-solid h-[46px] w-[46px] shrink-0 p-0" disabled={!text.trim() || !online} aria-label="Enviar">
            <SendHorizontal className="h-5 w-5" />
          </motion.button>
        )}
      </form>
    </div>
  );
}

function Bubble({ item: m, approve }: { item: ChatItem; approve: (id: string, ok: boolean) => void }) {
  if (m.kind === 'user') return <div className="whitespace-pre-wrap rounded-[18px] rounded-br-md bg-accent px-3.5 py-2.5 text-[15px] text-on-accent">{m.text}</div>;
  if (m.kind === 'assistant')
    return (
      <div className="m-card m-rich whitespace-pre-wrap rounded-[18px] rounded-bl-md px-3.5 py-2.5 text-[15px] leading-relaxed">
        <RichText text={m.text || '…'} />
      </div>
    );
  if (m.kind === 'notice') return <div className="px-1 text-[13px] italic text-muted">{m.text}</div>;

  const pending = m.status === 'pending';
  const isCmd = m.kind === 'command';
  return (
    <div className={`m-card overflow-hidden p-3 ${pending ? 'border-warn' : ''}`}>
      <div className="flex items-center gap-2 text-[13px] font-semibold text-muted">
        {isCmd ? <Terminal className="h-4 w-4" /> : <FilePen className="h-4 w-4" />}
        {isCmd ? 'Comando no PC' : 'Gravar arquivo no PC'}
        <span className="ml-auto text-[12px] font-medium">{statusLabel(m)}</span>
      </div>
      {isCmd && m.reason && <p className="mt-1 text-[14px]">{m.reason}</p>}
      <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-xl bg-surface-2 p-2.5 font-mono text-[12.5px]">{isCmd ? `$ ${m.command}` : `${m.path}\n\n${m.preview}`}</pre>
      {isCmd && m.output.length > 0 && <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[11.5px] text-muted">{m.output.slice(-40).join('\n')}</pre>}
      {pending && (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" className="m-btn m-btn-danger" onClick={() => approve(m.id, false)}>
            <X className="h-4 w-4" /> Recusar
          </button>
          <button type="button" className="m-btn m-btn-solid" onClick={() => approve(m.id, true)}>
            <Check className="h-4 w-4" /> Aprovar
          </button>
        </div>
      )}
    </div>
  );
}

function statusLabel(m: Extract<ChatItem, { kind: 'command' | 'write' }>) {
  if (m.status === 'pending') return 'aguardando você';
  if (m.status === 'refused') return 'recusado';
  if (m.kind === 'command') return m.status === 'running' ? 'rodando…' : m.code === 0 ? 'ok' : `código ${m.code ?? '?'}`;
  return m.error ? `erro: ${m.error}` : 'gravado';
}
