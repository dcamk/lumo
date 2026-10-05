import { Pause, Play, Plus, SkipBack, SkipForward, Terminal, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatUptime, pct, useMedia, type SystemStats } from '../../hooks/useSystem';
import { itemIn, meterTo, shake } from '../../lib/motion';
import { invoke, isTauri } from '../../lib/tauri';
import type { QuickAction } from '../../types';

/** Ações prontas (as do usuário entram depois delas) */
const BUILTIN: QuickAction[] = [
  { id: 'b-term', label: 'Terminal', command: '', mode: 'terminal' },
  { id: 'b-update', label: 'Atualizar sistema', command: 'sudo apt update && sudo apt upgrade', mode: 'terminal' },
  { id: 'b-monitor', label: 'Monitor', command: 'gnome-system-monitor || plasma-systemmonitor || xfce4-taskmanager', mode: 'launch' },
  { id: 'b-ip', label: 'Meu IP', command: "echo \"Local: $(hostname -I | awk '{print $1}')\"; echo \"Público: $(curl -s --max-time 5 https://ifconfig.me || echo indisponível)\"", mode: 'output' },
  { id: 'b-disk', label: 'Discos', command: 'df -h --output=target,size,used,avail,pcent -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs', mode: 'output' },
  { id: 'b-ports', label: 'Portas', command: "ss -tln | awk 'NR==1 || /LISTEN/' | head -15", mode: 'output' },
  { id: 'b-lock', label: 'Bloquear tela', command: 'loginctl lock-session', mode: 'launch' },
];

const MODE_LABEL: Record<QuickAction['mode'], string> = { output: 'Mostrar saída', terminal: 'No terminal', launch: 'Abrir programa' };

interface Props {
  stats: SystemStats | null;
  actions: QuickAction[];
  onActionsChange: (actions: QuickAction[]) => void;
  onActionDone: (ok: boolean) => void;
}

function Meter({ label, value, pctValue, title }: { label: string; value: string; pctValue: number; title?: string }) {
  const bar = useRef<HTMLDivElement | null>(null);
  useEffect(() => meterTo(bar.current, pctValue), [pctValue]);
  const hot = pctValue >= 90 ? 'bg-amber-400' : 'lumo-pill';
  return (
    <div data-anim="item" className="min-w-0" title={title}>
      <div className="flex items-baseline justify-between text-[10px]">
        <span className="text-slate-500">{label}</span>
        <span className="text-slate-200 tabular-nums">{value}</span>
      </div>
      <div className="h-1 mt-0.5 rounded-full bg-white/10 overflow-hidden">
        <div ref={bar} className={`h-full rounded-full ${hot}`} style={{ width: 0 }} />
      </div>
    </div>
  );
}

/** Aba Sistema: uso do PC, player de mídia e ações rápidas */
export function LinuxTab({ stats: s, actions, onActionsChange, onActionDone }: Props) {
  const { media, control } = useMedia(true);
  const [running, setRunning] = useState<string | null>(null);
  const [output, setOutput] = useState<{ label: string; text: string; ok: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState<Omit<QuickAction, 'id'>>({ label: '', command: '', mode: 'output' });
  const outRef = useRef<HTMLDivElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  useEffect(() => itemIn(outRef.current), [output]);

  const run = async (a: QuickAction) => {
    setRunning(a.id);
    try {
      const text = await invoke<string>('run_command', { command: a.command, mode: a.mode });
      if (a.mode === 'output') setOutput({ label: a.label, text: text || '(sem saída)', ok: true });
      onActionDone(true);
    } catch (err) {
      setOutput({ label: a.label, text: String(err), ok: false });
      onActionDone(false);
    } finally {
      setRunning(null);
    }
  };

  const saveDraft = (e: React.FormEvent) => {
    e.preventDefault();
    if (!draft.label.trim() || (!draft.command.trim() && draft.mode !== 'terminal')) {
      shake(formRef.current);
      return;
    }
    onActionsChange([...actions, { ...draft, label: draft.label.trim(), command: draft.command.trim(), id: crypto.randomUUID() }]);
    setDraft({ label: '', command: '', mode: 'output' });
    setAdding(false);
  };

  const cpuTitle = s?.top.length ? `Mais pesados: ${s.top.map((p) => `${p.name} ${p.cpu.toFixed(0)}%`).join(' · ')}` : undefined;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pr-1 pt-2 space-y-2 text-[11px]">
      {!isTauri() && <p className="text-slate-500">Disponível no app instalado.</p>}

      {s && (
        <>
          <div className="grid grid-cols-4 gap-2">
            <Meter label="CPU" value={`${s.cpu.toFixed(0)}%`} pctValue={s.cpu} title={cpuTitle} />
            <Meter
              label="RAM"
              value={formatBytes(s.mem_used).replace(' ', '')}
              pctValue={pct(s.mem_used, s.mem_total)}
              title={`${formatBytes(s.mem_used)} de ${formatBytes(s.mem_total)}`}
            />
            <Meter
              label="Disco"
              value={`${pct(s.disk_used, s.disk_total).toFixed(0)}%`}
              pctValue={pct(s.disk_used, s.disk_total)}
              title={`${formatBytes(s.disk_total - s.disk_used)} livres em /`}
            />
            {s.battery != null ? (
              <Meter label={s.charging ? 'Bateria (carregando)' : 'Bateria'} value={`${s.battery}%`} pctValue={s.battery} />
            ) : (
              <Meter label="Temp." value={s.temp != null ? `${s.temp.toFixed(0)}°C` : '—'} pctValue={s.temp ?? 0} />
            )}
          </div>
          <p data-anim="item" className="flex gap-3 text-[10px] text-slate-500 tabular-nums">
            <span>↓ {formatBytes(s.net_down)}/s</span>
            <span>↑ {formatBytes(s.net_up)}/s</span>
            <span>ligado há {formatUptime(s.uptime)}</span>
            <span title="Carga média de 1 min / núcleos">carga {s.load.toFixed(1)}/{s.cores}</span>
          </p>
        </>
      )}

      {media && (
        <div data-anim="item" className="flex items-center gap-2 px-2 py-1 rounded-xl bg-surface">
          <div className="min-w-0 flex-1">
            <p className="text-white truncate">{media.title || 'Sem título'}</p>
            <p className="text-[10px] text-slate-500 truncate">
              {media.artist || media.player}
            </p>
          </div>
          <button type="button" aria-label="Anterior" onClick={() => control('Previous')} className="p-1 rounded-full text-slate-300 hover:text-white hover:bg-white/10">
            <SkipBack className="w-3.5 h-3.5" />
          </button>
          <button type="button" aria-label={media.playing ? 'Pausar' : 'Tocar'} onClick={() => control('PlayPause')} className="p-1.5 rounded-full bg-white text-black hover:bg-slate-200">
            {media.playing ? <Pause className="w-3 h-3" /> : <Play className="w-3 h-3" />}
          </button>
          <button type="button" aria-label="Próxima" onClick={() => control('Next')} className="p-1 rounded-full text-slate-300 hover:text-white hover:bg-white/10">
            <SkipForward className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div data-anim="item" className="flex flex-wrap gap-1">
        {[...BUILTIN, ...actions].map((a) => {
          const custom = !a.id.startsWith('b-');
          return (
            <span key={a.id} className="group relative">
              <button
                type="button"
                disabled={running !== null}
                onClick={() => void run(a)}
                title={a.command ? `${MODE_LABEL[a.mode]}: ${a.command}` : 'Abrir um terminal'}
                className={`flex items-center gap-1 px-2.5 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white disabled:opacity-50 transition-colors ${custom ? 'pr-5' : ''}`}
              >
                {a.mode === 'terminal' && <Terminal className="w-3 h-3 text-slate-400" />}
                {running === a.id ? '…' : a.label}
              </button>
              {custom && (
                <button
                  type="button"
                  aria-label={`Remover ${a.label}`}
                  onClick={() => onActionsChange(actions.filter((x) => x.id !== a.id))}
                  className="absolute right-1 top-1 p-0.5 rounded-full text-slate-500 hover:text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                >
                  <X className="w-2.5 h-2.5" />
                </button>
              )}
            </span>
          );
        })}
        <button
          type="button"
          aria-label="Nova ação"
          title="Nova ação (um comando seu)"
          onClick={() => setAdding((v) => !v)}
          className={`px-2 h-6 rounded-full transition-colors ${adding ? 'bg-white/20 text-white' : 'bg-white/5 text-slate-400 hover:text-white'}`}
        >
          <Plus className="w-3 h-3" />
        </button>
      </div>

      {adding && (
        <form ref={formRef} onSubmit={saveDraft} className="flex items-center gap-1">
          <input
            autoFocus
            aria-label="Nome da ação"
            placeholder="Nome"
            value={draft.label}
            onChange={(e) => setDraft({ ...draft, label: e.target.value })}
            className="w-20 bg-surface-2 border border-white/5 rounded-xl px-2 py-1 text-white placeholder-slate-600 focus:outline-none focus:border-white/20"
          />
          <input
            aria-label="Comando"
            placeholder="comando (ex.: flatpak update -y)"
            value={draft.command}
            onChange={(e) => setDraft({ ...draft, command: e.target.value })}
            className="flex-1 min-w-0 font-mono bg-surface-2 border border-white/5 rounded-xl px-2 py-1 text-white placeholder-slate-600 focus:outline-none focus:border-white/20"
          />
          <select
            aria-label="Como executar"
            value={draft.mode}
            onChange={(e) => setDraft({ ...draft, mode: e.target.value as QuickAction['mode'] })}
            className="lumo-select bg-surface-2 border border-white/5 rounded-xl px-1 py-1 text-white focus:outline-none"
          >
            {(Object.keys(MODE_LABEL) as QuickAction['mode'][]).map((m) => (
              <option key={m} value={m}>
                {MODE_LABEL[m]}
              </option>
            ))}
          </select>
          <button type="submit" className="lumo-pill px-2.5 h-6 rounded-full text-white font-semibold">
            Salvar
          </button>
        </form>
      )}

      {output && (
        <div ref={outRef} className="relative rounded-xl bg-surface-2 border border-white/5">
          <div className="flex items-center justify-between px-2 pt-1 text-[10px]">
            <span className={output.ok ? 'text-slate-400' : 'text-amber-400'}>{output.label}</span>
            <button type="button" aria-label="Fechar saída" onClick={() => setOutput(null)} className="p-0.5 text-slate-500 hover:text-white">
              <X className="w-3 h-3" />
            </button>
          </div>
          <pre className="px-2 pb-1.5 max-h-24 overflow-auto custom-scrollbar font-mono text-[10px] leading-snug text-slate-200 whitespace-pre-wrap select-text">
            {output.text}
          </pre>
        </div>
      )}
    </div>
  );
}
