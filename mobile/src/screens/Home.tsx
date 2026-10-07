// Início: o Lumo em destaque, o PC numa linha e atalhos
import { BellRing, Camera, MessageCircle, MonitorSmartphone } from 'lucide-react';
import { motion } from 'motion/react';
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
  go: (tab: 'chat' | 'cloud') => void;
  standby: () => void;
  toast: (text: string) => void;
}

export function Home({ bridge, palette, model, mood, poke, tilt, status, online, wide, go, standby, toast }: Props) {
  const s = status?.stats;

  const ping = async () => {
    haptic(10);
    try {
      await bridge.post('/api/ping', { text: 'Chamado do celular' });
      toast('Aviso enviado ao PC.');
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const actions = [
    { icon: MessageCircle, label: 'Perguntar', onClick: () => go('chat') },
    { icon: Camera, label: 'Enviar foto', onClick: () => go('cloud') },
    { icon: BellRing, label: 'Chamar PC', onClick: () => void ping() },
    { icon: MonitorSmartphone, label: 'Sempre ligado', onClick: standby },
  ];

  return (
    <div className={`flex h-full flex-col ${wide ? 'md:flex-row md:items-center md:gap-8 md:px-8' : ''}`}>
      <div className="relative min-h-0 flex-1">
        <LumoStage model={model} palette={palette} mood={mood} poke={poke} tilt={tilt} className="absolute inset-0" />
      </div>

      <div className={`flex flex-col gap-3 px-4 pb-4 ${wide ? 'md:w-[360px] md:px-0' : ''}`}>
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }} className="m-card flex items-center gap-3 px-4 py-3">
          <span className={`h-2 w-2 shrink-0 rounded-full ${online ? 'bg-ok' : 'bg-danger'}`} />
          <span className="flex-1 truncate text-[15px] font-medium">{status?.name ?? bridge.link.pc}</span>
          {s && online && (
            <span className="text-[13px] tabular-nums text-muted">
              CPU {Math.round(s.cpu)}% · RAM {Math.round((s.mem_used / Math.max(1, s.mem_total)) * 100)}%
            </span>
          )}
          {!online && <span className="text-[13px] text-danger">offline</span>}
        </motion.div>

        <div className="grid grid-cols-4 gap-2">
          {actions.map((a, i) => (
            <motion.button
              key={a.label}
              type="button"
              onClick={a.onClick}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 + i * 0.04, duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              whileTap={{ scale: 0.96 }}
              className="m-card flex flex-col items-center gap-1.5 px-1 py-3"
            >
              <a.icon className="h-5 w-5 text-accent" strokeWidth={1.75} />
              <span className="text-[12px] leading-tight text-muted">{a.label}</span>
            </motion.button>
          ))}
        </div>
      </div>
    </div>
  );
}
