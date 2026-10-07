// Tela inicial: o Lumo 3D em destaque, o PC num relance e atalhos de uso rápido
import { BellRing, Camera, ClipboardPaste, MessageCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import type { Palette } from '../../../src/theme/palettes';
import { haptic, type Bridge, type PcStatus } from '../lib/bridge';
import { LumoStage, type ModelId, type Mood, type Poke } from '../three/LumoStage';

interface Props {
  bridge: Bridge;
  palette: Palette;
  model: ModelId;
  mood: Mood;
  poke: Poke | null;
  tilt: boolean;
  status: PcStatus | null;
  online: boolean;
  wide: boolean;
  go: (tab: 'chat' | 'files' | 'control') => void;
  toast: (text: string) => void;
}

const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Boa madrugada' : h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
};

const LINES: Record<string, string[]> = {
  tap: ['Oi!', 'Opa!', 'Tô aqui.', 'Hehe.'],
  double: ['Wheee!', 'Mais uma volta?', 'Tontinho…'],
  hold: ['Gostei disso.', 'Carinho bom!', '✨'],
  shake: ['Ei, calma!', 'Tudo girando…', 'Assim eu fico tonto!'],
};
const pick = (arr: string[]) => arr[Math.floor(Math.random() * arr.length)];

export function Home({ bridge, palette, model, mood, poke, tilt, status, online, wide, go, toast }: Props) {
  const [bubble, setBubble] = useState<{ text: string; n: number } | null>(null);
  const s = status?.stats;

  const say = (what: keyof typeof LINES) => {
    haptic(what === 'shake' ? 40 : 10);
    const n = Date.now();
    setBubble({ text: pick(LINES[what]), n });
    window.setTimeout(() => setBubble((b) => (b?.n === n ? null : b)), 1800);
  };

  const ping = async () => {
    haptic(15);
    try {
      await bridge.post('/api/ping', { text: 'Oi do celular! 👋' });
      toast('Avisei o PC.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const pasteFromPc = async () => {
    try {
      const { text } = await bridge.get<{ text: string }>('/api/clipboard');
      if (!text) return toast('A área de transferência do PC está vazia.');
      try {
        await navigator.clipboard.writeText(text);
        toast('Texto do PC copiado aqui.');
      } catch {
        go('control');
        toast('Abri o Controle: o texto do PC está lá para copiar.');
        sessionStorage.setItem('lumo.mobile.pcclip', text);
      }
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const actions = [
    { icon: MessageCircle, label: 'Perguntar', onClick: () => go('chat') },
    { icon: Camera, label: 'Mandar foto', onClick: () => go('files') },
    { icon: ClipboardPaste, label: 'Colar do PC', onClick: () => void pasteFromPc() },
    { icon: BellRing, label: 'Chamar o PC', onClick: () => void ping() },
  ];

  return (
    <div className={`flex h-full flex-col ${wide ? 'md:flex-row md:items-center md:gap-8 md:px-8' : ''}`}>
      <div className="relative min-h-0 flex-1">
        <LumoStage model={model} palette={palette} mood={mood} poke={poke} tilt={tilt} className="absolute inset-0" onInteract={say} />
        {bubble && (
          <motion.div
            key={bubble.n}
            initial={{ opacity: 0, y: 10, scale: 0.8 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            className="m-card pointer-events-none absolute left-1/2 top-[8%] -translate-x-1/2 px-4 py-2 text-[15px] font-semibold"
          >
            {bubble.text}
          </motion.div>
        )}
      </div>

      <div className={`flex flex-col gap-3 px-4 pb-4 ${wide ? 'md:w-[380px] md:px-0' : ''}`}>
        <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.05 }}>
          <p className="text-[15px] text-muted">{greeting()}!</p>
          <h1 className="text-2xl font-bold leading-tight">
            Conectado a <span className="text-accent">{status?.name ?? bridge.link.pc}</span>
          </h1>
        </motion.div>

        <motion.button
          type="button"
          onClick={() => go('control')}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.1 }}
          className="m-card flex items-center gap-4 p-4 text-left active:scale-[0.98]"
        >
          <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${online ? 'bg-ok shadow-[0_0_10px_var(--ok)]' : 'bg-danger'}`} />
          {s ? (
            <div className="grid flex-1 grid-cols-3 gap-2 text-center">
              <Mini label="CPU" value={`${Math.round(s.cpu)}%`} />
              <Mini label="RAM" value={`${Math.round((s.mem_used / Math.max(1, s.mem_total)) * 100)}%`} />
              <Mini label={s.battery != null ? 'Bateria' : 'Temp.'} value={s.battery != null ? `${s.battery}%` : s.temp != null ? `${Math.round(s.temp)}°` : '—'} />
            </div>
          ) : (
            <span className="flex-1 text-[15px] text-muted">{online ? 'Lendo o PC…' : 'PC fora de alcance'}</span>
          )}
        </motion.button>

        <div className="grid grid-cols-4 gap-2">
          {actions.map((a, i) => (
            <motion.button
              key={a.label}
              type="button"
              onClick={a.onClick}
              initial={{ opacity: 0, y: 20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.15 + i * 0.05, type: 'spring', stiffness: 300, damping: 22 }}
              whileTap={{ scale: 0.9 }}
              className="m-card flex flex-col items-center gap-1.5 px-1 py-3"
            >
              <a.icon className="h-5 w-5 text-accent" />
              <span className="text-[12px] font-medium leading-tight">{a.label}</span>
            </motion.button>
          ))}
        </div>
        <p className="text-center text-[12px] text-muted">Toque, segure, arraste ou sacuda o Lumo.</p>
      </div>
    </div>
  );
}

function Mini({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-lg font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted">{label}</div>
    </div>
  );
}
