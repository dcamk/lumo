// Ajustes do app móvel: modelo 3D, paleta, sensores e a conexão com o PC
import { Check, Laptop, LogOut, Smartphone, Vibrate } from 'lucide-react';
import { motion } from 'motion/react';
import { PALETTE_ORDER, PALETTES } from '../../../src/theme/palettes';
import type { Bridge } from '../lib/bridge';
import type { Prefs } from '../lib/prefs';
import { MODELS } from '../three/LumoStage';

interface Props {
  bridge: Bridge;
  prefs: Prefs;
  patch: (p: Partial<Prefs>) => void;
  onDisconnect: () => void;
}

export function Settings({ bridge, prefs, patch, onDisconnect }: Props) {
  return (
    <div className="m-scroll flex h-full flex-col gap-5 px-4 pb-6">
      <h2 className="text-xl font-bold">Ajustes</h2>

      <section className="flex flex-col gap-2">
        <span className="m-label">Modelo 3D</span>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {MODELS.map((m) => (
            <motion.button
              key={m.id}
              type="button"
              whileTap={{ scale: 0.95 }}
              aria-pressed={prefs.model === m.id}
              onClick={() => patch({ model: m.id })}
              className={`m-card relative p-3 text-left ${prefs.model === m.id ? 'border-accent' : ''}`}
            >
              <ModelIcon id={m.id} />
              <div className="mt-2 font-semibold">{m.name}</div>
              <div className="text-[12px] leading-snug text-muted">{m.hint}</div>
              {prefs.model === m.id && <Check className="absolute right-3 top-3 h-4 w-4 text-accent" />}
            </motion.button>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="m-label">Personalidade e cores</span>
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {PALETTE_ORDER.map((id) => {
            const p = PALETTES[id];
            const on = prefs.palette === id;
            return (
              <motion.button key={id} type="button" whileTap={{ scale: 0.92 }} aria-pressed={on} onClick={() => patch({ palette: id })} className={`m-card flex flex-col items-center gap-1.5 p-3 ${on ? 'border-accent' : ''}`}>
                <span className="h-9 w-9 rounded-full border border-line" style={{ background: `linear-gradient(135deg, ${p.colors.bodyTop}, ${p.colors.accent})`, boxShadow: on ? `0 0 16px -2px ${p.colors.accent}` : undefined }} />
                <span className="text-[13px] font-semibold">{p.name}</span>
                <span className="text-[11px] text-muted">{p.tagline}</span>
              </motion.button>
            );
          })}
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <span className="m-label">Sensores</span>
        <Toggle icon={Smartphone} label="Lumo segue a inclinação" hint="Incline o aparelho e ele olha junto" on={prefs.tilt} set={(v) => patch({ tilt: v })} />
        <Toggle icon={Vibrate} label="Vibrar nos toques" hint="Só no Android" on={prefs.haptics} set={(v) => patch({ haptics: v })} />
      </section>

      <section className="flex flex-col gap-2">
        <span className="m-label">Conexão</span>
        <div className="m-card flex items-center gap-3 p-4">
          <Laptop className="h-5 w-5 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="font-semibold">{bridge.link.pc}</div>
            <div className="truncate text-[13px] text-muted">{bridge.link.base}</div>
          </div>
        </div>
        <button type="button" className="m-btn m-btn-danger" onClick={onDisconnect}>
          <LogOut className="h-4 w-4" /> Desconectar este aparelho
        </button>
        <p className="text-[12px] text-muted">
          A IA roda no PC: as chaves dos provedores (Claude, Gemini…) nunca vêm para o celular. Dica: no navegador, use “Adicionar à tela inicial” para abrir o Lumo como app.
        </p>
      </section>
    </div>
  );
}

function Toggle({ icon: Icon, label, hint, on, set }: { icon: typeof Check; label: string; hint: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)} className="m-card flex items-center gap-3 p-4 text-left">
      <Icon className="h-5 w-5 text-accent" />
      <div className="flex-1">
        <div className="font-semibold">{label}</div>
        <div className="text-[12px] text-muted">{hint}</div>
      </div>
      <span className={`relative h-7 w-12 rounded-full transition-colors ${on ? 'bg-accent' : 'bg-surface-3'}`}>
        <motion.span layout transition={{ type: 'spring', stiffness: 500, damping: 30 }} className="absolute top-1 h-5 w-5 rounded-full bg-ink" style={{ left: on ? 24 : 4 }} />
      </span>
    </button>
  );
}

/** Ícone desenhado de cada modelo (sem abrir outro WebGL só para a miniatura) */
function ModelIcon({ id }: { id: string }) {
  const common = { fill: 'color-mix(in srgb, var(--accent) 30%, var(--surface-3))', stroke: 'var(--accent)', strokeWidth: 2 };
  return (
    <svg viewBox="0 0 48 48" className="h-10 w-10" aria-hidden>
      {id === 'cubo' && <rect x="8" y="8" width="32" height="32" rx="10" {...common} />}
      {id === 'orbe' && (
        <>
          <circle cx="24" cy="24" r="14" {...common} />
          <ellipse cx="24" cy="24" rx="22" ry="7" fill="none" stroke="var(--accent)" strokeWidth="2" transform="rotate(-18 24 24)" />
        </>
      )}
      {id === 'cristal' && <polygon points="24,4 42,18 36,42 12,42 6,18" {...common} />}
      {id === 'gota' && <path d="M24 6c8 9 15 16 15 24a15 15 0 0 1-30 0c0-8 7-15 15-24z" {...common} />}
      <rect x="18" y="20" width="3.5" height="8" rx="1.75" fill="var(--text)" />
      <rect x="26.5" y="20" width="3.5" height="8" rx="1.75" fill="var(--text)" />
    </svg>
  );
}
