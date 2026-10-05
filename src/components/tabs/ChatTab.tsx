import { Check, ChevronDown, ChevronRight, CloudUpload, FileText, Folder, Send, Square, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { itemIn } from '../../lib/motion';
import { RichText } from '../RichText';
import type { ChatItem, DroppedFile } from '../../types';

interface Props {
  items: ChatItem[];
  loading: boolean;
  providerLabel: string;
  onSend: (text: string) => void;
  onApprove: (id: string, ok: boolean) => void;
  onStop: () => void;
  /** Usuário digitando (o Lumo presta atenção) */
  onTyping: () => void;
  /** Conta Google conectada: botão "Enviar ao Drive" nos arquivos */
  driveEnabled: boolean;
  onSendToDrive: (file: DroppedFile) => void;
}

function FileChip({ file, drive, onDrive }: { file: DroppedFile; drive: boolean; onDrive: (f: DroppedFile) => void }) {
  const Icon = file.is_dir ? Folder : FileText;
  return (
    <span className="inline-flex items-center gap-1 max-w-[220px] h-5 pl-1.5 pr-1 rounded-full bg-black/30 text-[10px]" title={file.path}>
      <Icon className="w-3 h-3 shrink-0 opacity-70" />
      <span className="truncate">{file.name}</span>
      {drive && !file.is_dir && (
        <button type="button" aria-label="Enviar ao Drive" title="Enviar ao Drive" onClick={() => onDrive(file)} className="p-0.5 rounded-full hover:bg-white/15">
          <CloudUpload className="w-3 h-3" />
        </button>
      )}
    </span>
  );
}

function CommandCard({ item, onApprove }: { item: Extract<ChatItem, { kind: 'command' }>; onApprove: Props['onApprove'] }) {
  const [open, setOpen] = useState(true);
  const outRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight;
  }, [item.output.length]);

  const status =
    item.status === 'pending'
      ? { text: 'aguardando você', cls: 'text-amber-300' }
      : item.status === 'running'
        ? { text: 'executando…', cls: 'text-sky-300 animate-pulse' }
        : item.status === 'refused'
          ? { text: 'recusado', cls: 'text-slate-500' }
          : item.code === 0
            ? { text: 'concluído', cls: 'text-emerald-400' }
            : { text: item.code == null ? 'interrompido' : `erro (código ${item.code})`, cls: 'text-amber-400' };

  return (
    <div className="rounded-xl bg-surface-2 border border-white/[0.06] overflow-hidden">
      <div className="flex items-center gap-1.5 px-2 pt-1.5">
        <Terminal className="w-3 h-3 text-slate-500 shrink-0" />
        <span className="text-[10px] text-slate-400 truncate flex-1">{item.reason || 'Comando'}</span>
        <span className={`text-[10px] shrink-0 ${status.cls}`}>{status.text}</span>
        {item.output.length > 0 && (
          <button type="button" aria-label={open ? 'Esconder saída' : 'Mostrar saída'} onClick={() => setOpen((v) => !v)} className="text-slate-500 hover:text-white">
            {open ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
          </button>
        )}
      </div>
      <pre className="px-2 py-1 font-mono text-[10.5px] text-slate-100 whitespace-pre-wrap break-all select-text">
        <span className="text-slate-500">$ </span>
        {item.command}
      </pre>
      {open && item.output.length > 0 && (
        <pre ref={outRef} className="mx-2 mb-1.5 px-1.5 py-1 max-h-28 overflow-auto custom-scrollbar rounded-lg bg-black font-mono text-[10px] leading-snug text-slate-400 whitespace-pre-wrap break-all select-text">
          {item.output.join('\n')}
        </pre>
      )}
      {item.status === 'pending' && (
        <div className="flex gap-1.5 px-2 pb-1.5">
          <button type="button" onClick={() => onApprove(item.id, true)} className="lumo-pill inline-flex items-center gap-1 px-3 h-6 rounded-full text-[11px] font-semibold text-white">
            <Check className="w-3 h-3" /> Executar
          </button>
          <button type="button" onClick={() => onApprove(item.id, false)} className="inline-flex items-center gap-1 px-3 h-6 rounded-full bg-white/10 hover:bg-white/20 text-[11px] text-white">
            <X className="w-3 h-3" /> Recusar
          </button>
        </div>
      )}
    </div>
  );
}

function WriteCard({ item, onApprove }: { item: Extract<ChatItem, { kind: 'write' }>; onApprove: Props['onApprove'] }) {
  return (
    <div className="rounded-xl bg-surface-2 border border-white/[0.06] px-2 py-1.5 space-y-1">
      <div className="flex items-center gap-1.5 text-[10px]">
        <FileText className="w-3 h-3 text-slate-500" />
        <span className="text-slate-300 truncate flex-1 font-mono" title={item.path}>
          gravar {item.path}
        </span>
        <span className={item.status === 'pending' ? 'text-amber-300' : item.status === 'refused' ? 'text-slate-500' : item.error ? 'text-amber-400' : 'text-emerald-400'}>
          {item.status === 'pending' ? 'aguardando você' : item.status === 'refused' ? 'recusado' : item.error ? 'erro' : 'gravado'}
        </span>
      </div>
      <pre className="max-h-20 overflow-auto custom-scrollbar rounded-lg bg-black px-1.5 py-1 font-mono text-[10px] text-slate-400 whitespace-pre-wrap">{item.preview}</pre>
      {item.status === 'pending' && (
        <div className="flex gap-1.5">
          <button type="button" onClick={() => onApprove(item.id, true)} className="lumo-pill px-3 h-6 rounded-full text-[11px] font-semibold text-white">
            Gravar
          </button>
          <button type="button" onClick={() => onApprove(item.id, false)} className="px-3 h-6 rounded-full bg-white/10 hover:bg-white/20 text-[11px] text-white">
            Recusar
          </button>
        </div>
      )}
    </div>
  );
}

export function ChatTab({ items, loading, providerLabel, onSend, onApprove, onStop, onTyping, driveEnabled, onSendToDrive }: Props) {
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement | null>(null);
  const known = useRef(new Set(items.map((m) => m.id)));
  const refs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    // rola só a lista (scrollIntoView rolaria também a janela inteira)
    const list = listRef.current;
    if (list) list.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
    for (const m of items) if (!known.current.has(m.id)) itemIn(refs.current.get(m.id) ?? null);
    known.current = new Set(items.map((m) => m.id));
  }, [items, loading]);

  const waiting = items.some((m) => (m.kind === 'command' || m.kind === 'write') && m.status === 'pending');

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || loading) return;
    onSend(input.trim());
    setInput('');
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col justify-between pt-1 overflow-hidden">
      <div ref={listRef} className="flex-1 overflow-y-auto space-y-1.5 pr-1 custom-scrollbar text-[11px]">
        {items.map((m) => (
          <div
            key={m.id}
            data-anim="item"
            ref={(el) => {
              if (el) refs.current.set(m.id, el);
              else refs.current.delete(m.id);
            }}
            className={`flex ${m.kind === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            {m.kind === 'user' && (
              <div className="max-w-[85%] px-2.5 py-1.5 rounded-xl bg-white/15 text-white leading-relaxed whitespace-pre-wrap select-text">
                {m.files?.length ? (
                  <span className="flex flex-wrap gap-1 pb-1">
                    {m.files.map((f) => (
                      <FileChip key={f.path} file={f} drive={driveEnabled} onDrive={onSendToDrive} />
                    ))}
                  </span>
                ) : null}
                {m.text}
              </div>
            )}
            {m.kind === 'assistant' && (
              <div className="max-w-[90%] px-2.5 py-1.5 rounded-xl bg-surface-2 text-slate-300 leading-relaxed whitespace-pre-wrap select-text">
                <RichText text={m.text} />
                {m.via && <span className="block pt-0.5 text-[9px] text-slate-500">respondido via {m.via}</span>}
              </div>
            )}
            {m.kind === 'notice' && <p className="text-[10px] text-slate-500 italic px-1">{m.text}</p>}
            {m.kind === 'command' && (
              <div className="w-full">
                <CommandCard item={m} onApprove={onApprove} />
              </div>
            )}
            {m.kind === 'write' && (
              <div className="w-full">
                <WriteCard item={m} onApprove={onApprove} />
              </div>
            )}
          </div>
        ))}
        {loading && !waiting && <div className="text-slate-500 text-[10px] animate-pulse">Lumo está trabalhando…</div>}
      </div>

      <form onSubmit={submit} className="pt-2 flex items-center gap-1.5 shrink-0">
        <input
          type="text"
          aria-label="Mensagem para o Lumo"
          placeholder="Peça algo ao Lumo…"
          title={`Provedor preferido: ${providerLabel} (troca sozinho se ele não responder)`}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            onTyping();
          }}
          className="flex-1 bg-surface-2 border border-white/5 rounded-xl px-2.5 py-1 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-white/20"
        />
        {loading ? (
          <button type="button" aria-label="Parar" title="Parar" onClick={onStop} className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white transition-colors">
            <Square className="w-3 h-3" />
          </button>
        ) : (
          <button type="submit" aria-label="Enviar" disabled={!input.trim()} className="p-1.5 rounded-xl bg-white/10 hover:bg-white/20 text-white disabled:opacity-30 transition-colors">
            <Send className="w-3 h-3" />
          </button>
        )}
      </form>
    </div>
  );
}
