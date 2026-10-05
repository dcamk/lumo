import { useEffect, useRef } from 'react';
import { FOCUS_DURATION, formatTimer, type FocusNotice, type PomodoroPhase } from '../../hooks/usePomodoro';
import { pulse } from '../../lib/motion';

interface Props {
  phase: PomodoroPhase;
  timeLeft: number;
  running: boolean;
  notice: FocusNotice;
  onToggle: () => void;
  onSelectPhase: (p: PomodoroPhase) => void;
}

export function FocusTab({ phase, timeLeft, running, notice, onToggle, onSelectPhase }: Props) {
  const label = running
    ? phase === 'focus' ? 'Encerrar foco' : 'Encerrar pausa'
    : phase === 'focus' ? 'Iniciar foco' : 'Iniciar pausa';
  const timerRef = useRef<HTMLSpanElement | null>(null);
  const progress = 1 - timeLeft / FOCUS_DURATION[phase];

  // Pulso no timer ao iniciar/parar e ao trocar de fase
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    pulse(timerRef.current);
  }, [running, phase]);

  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
      <div className="min-h-full flex flex-col items-center justify-center gap-2 py-2">
        <span ref={timerRef} data-anim="item" className="text-2xl font-mono tabular-nums text-white">
          {formatTimer(timeLeft)}
        </span>
        <div data-anim="item" className="w-40 h-1 rounded-full bg-white/10 overflow-hidden" aria-hidden>
          <div className="lumo-pill h-full rounded-full transition-[width] duration-1000 ease-linear" style={{ width: `${progress * 100}%` }} />
        </div>

        <button
          type="button"
          data-anim="item"
          onClick={onToggle}
          className={`px-4 py-1.5 rounded-full font-semibold text-xs transition-colors ${
            running ? 'bg-white/10 text-white border border-white/20 hover:bg-white/15' : 'bg-white text-black hover:bg-slate-200'
          }`}
        >
          {label}
        </button>

        <div data-anim="item" className="flex items-center gap-1 bg-surface-2 p-0.5 rounded-full text-[10px]">
          {(['focus', 'break'] as const).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onSelectPhase(p)}
              className={`px-2 py-0.5 rounded-full transition-colors ${phase === p ? 'bg-white/10 text-white' : 'text-slate-400'}`}
            >
              {p === 'focus' ? 'Foco 25m' : 'Pausa 5m'}
            </button>
          ))}
        </div>

        {/* Só aparece quando há algo a dizer (ex.: não deu para silenciar as notificações) */}
        {notice?.kind === 'warn' && (
          <p className="max-w-[270px] text-center text-[10px] leading-snug text-amber-400">{notice.text}</p>
        )}
      </div>
    </div>
  );
}
