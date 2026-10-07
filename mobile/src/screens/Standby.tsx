// Modo sempre ligado: o celular vira um painel de mesa (como o StandBy do iPhone).
// Relógio grande, o Lumo em descanso e o PC num relance. A tela não apaga (Wake Lock) e o
// conteúdo se desloca alguns pixels por minuto para não marcar telas OLED.
import { Music2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { Palette } from '../../../src/theme/palettes';
import type { PcStatus } from '../lib/bridge';
import { LumoStage, type ModelId, type Mood } from '../three/LumoStage';

interface Props {
  palette: Palette;
  model: ModelId;
  mood: Mood;
  status: PcStatus | null;
  online: boolean;
  onExit: () => void;
}

type WakeLock = { release: () => Promise<void> };

export function Standby({ palette, model, mood, status, online, onExit }: Props) {
  const [now, setNow] = useState(() => new Date());
  const [shift, setShift] = useState({ x: 0, y: 0 });
  const [controls, setControls] = useState(false);
  const hideTimer = useRef(0);

  // Relógio + deslocamento anti-marcação
  useEffect(() => {
    const id = window.setInterval(() => {
      const d = new Date();
      setNow(d);
      if (d.getSeconds() === 0) setShift({ x: Math.round((Math.random() - 0.5) * 16), y: Math.round((Math.random() - 0.5) * 16) });
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Tela sempre acesa enquanto este modo estiver aberto
  useEffect(() => {
    let lock: WakeLock | null = null;
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<WakeLock> } };
    const ask = async () => {
      try {
        if (!document.hidden) lock = (await nav.wakeLock?.request('screen')) ?? null;
      } catch {
        /* sem suporte (http sem HTTPS em alguns navegadores): segue sem */
      }
    };
    void ask();
    const onVis = () => !document.hidden && void ask();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      void lock?.release().catch(() => {});
    };
  }, []);

  const reveal = () => {
    setControls(true);
    clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => setControls(false), 3500);
  };

  const exit = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    onExit();
  };

  const time = now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' });
  const s = status?.stats;
  const media = status?.media;

  return (
    <motion.div
      className="fixed inset-0 z-[60] overflow-hidden bg-black text-white"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      onClick={reveal}
    >
      <motion.div
        className="flex h-full flex-col items-center justify-center gap-2 px-6 landscape:flex-row landscape:gap-10"
        animate={{ x: shift.x, y: shift.y }}
        transition={{ duration: 2, ease: 'easeInOut' }}
        style={{ paddingTop: 'var(--safe-top)', paddingBottom: 'var(--safe-bottom)' }}
      >
        <LumoStage model={model} palette={palette} mood={mood} interactive={false} tilt={false} dim={0.75} className="h-[34vh] w-full max-w-xs landscape:h-[60vh] landscape:max-w-sm" />
        <div className="flex flex-col items-center landscape:items-start">
          <div className="font-light tabular-nums leading-none tracking-tight" style={{ fontSize: 'clamp(64px, 18vw, 148px)' }}>
            {time}
          </div>
          <div className="mt-2 text-[16px] capitalize text-white/55">{date}</div>
          <div className="mt-6 flex flex-col items-center gap-1.5 text-[14px] text-white/45 landscape:items-start">
            <span className="flex items-center gap-2">
              <span className={`h-1.5 w-1.5 rounded-full ${online ? 'bg-emerald-400' : 'bg-red-400'}`} />
              {online ? `${status?.name ?? 'PC'}${s ? ` · CPU ${Math.round(s.cpu)}% · RAM ${Math.round((s.mem_used / Math.max(1, s.mem_total)) * 100)}%` : ''}` : 'PC fora de alcance'}
            </span>
            {media?.title && (
              <span className="flex max-w-[80vw] items-center gap-2 truncate">
                <Music2 className="h-3.5 w-3.5 shrink-0" /> {media.title}
                {media.artist ? ` · ${media.artist}` : ''}
              </span>
            )}
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {controls && (
          <motion.button
            type="button"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute right-4 flex items-center gap-2 rounded-full bg-white/12 px-4 py-2 text-[14px]"
            style={{ top: 'calc(var(--safe-top) + 14px)' }}
            onClick={(e) => {
              e.stopPropagation();
              exit();
            }}
          >
            <X className="h-4 w-4" /> Sair
          </motion.button>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/** Entra em tela cheia (precisa vir de um toque) */
export function goFullscreen() {
  const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => void };
  try {
    if (el.requestFullscreen) void el.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    else el.webkitRequestFullscreen?.();
  } catch {
    /* iPhone não tem tela cheia para páginas: segue normal */
  }
}
