import { useEffect, useRef, useState } from 'react';
import { tryInvoke } from '../lib/tauri';

export type PomodoroPhase = 'focus' | 'break';
export type FocusNotice = { kind: 'ok' | 'warn'; text: string } | null;

export const FOCUS_DURATION: Record<PomodoroPhase, number> = { focus: 25 * 60, break: 5 * 60 };
const DURATION = FOCUS_DURATION;

interface DndResult {
  status: 'enabled' | 'already_on' | 'disabled' | 'unverified' | 'unsupported' | 'failed';
  message: string;
}

/**
 * Timer Pomodoro + "Não Perturbe" do sistema (GNOME/KDE).
 * Ligar o timer em modo foco liga o Não Perturbe; parar/terminar desliga.
 */
export function usePomodoro(onFinish: (finished: PomodoroPhase) => void) {
  const [phase, setPhase] = useState<PomodoroPhase>('focus');
  const [timeLeft, setTimeLeft] = useState(DURATION.focus);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState<FocusNotice>(null);

  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  // Contagem regressiva
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setTimeLeft((t) => Math.max(0, t - 1)), 1000);
    return () => window.clearInterval(id);
  }, [running]);

  // Fim do ciclo: troca de fase fora do updater (sem efeitos colaterais duplicados)
  useEffect(() => {
    if (!running || timeLeft > 0) return;
    const next: PomodoroPhase = phase === 'focus' ? 'break' : 'focus';
    setRunning(false);
    setPhase(next);
    setTimeLeft(DURATION[next]);
    onFinishRef.current(phase);
  }, [running, timeLeft, phase]);

  // Não Perturbe acompanha "foco rodando"; a fila evita chamadas sobrepostas
  const dndOn = useRef(false);
  const queue = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const want = running && phase === 'focus';
    if (want === dndOn.current) return;
    dndOn.current = want;
    queue.current = queue.current
      .then(async () => {
        const res = await tryInvoke<DndResult>('set_focus_dnd', { enable: want });
        if (!res) {
          setNotice(
            want
              ? { kind: 'warn', text: 'Sem acesso ao app nativo: o timer roda, mas as notificações NÃO estão silenciadas.' }
              : null
          );
        } else if (res.status === 'disabled') {
          setNotice(null);
        } else {
          const ok = res.status === 'enabled' || res.status === 'already_on';
          setNotice({ kind: ok ? 'ok' : 'warn', text: res.message });
        }
      })
      .catch(() => {});
  }, [running, phase]);

  const toggle = () => {
    if (running) {
      setRunning(false);
      setTimeLeft(DURATION[phase]);
    } else {
      setRunning(true);
    }
  };

  const selectPhase = (p: PomodoroPhase) => {
    setRunning(false);
    setPhase(p);
    setTimeLeft(DURATION[p]);
  };

  return { phase, timeLeft, running, notice, toggle, selectPhase };
}

export const formatTimer = (sec: number) =>
  `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
