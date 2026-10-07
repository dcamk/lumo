// Ajustes: aparência, modelo, sensores, sempre ligado e conexão
import { LogOut, Moon, Sun } from 'lucide-react';
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

const spring = { type: 'spring', stiffness: 420, damping: 34 } as const;

export function Settings({ bridge, prefs, patch, onDisconnect }: Props) {
  return (
    <div className="m-scroll flex h-full flex-col gap-6 px-4 pb-6">
      <h2 className="text-xl font-semibold tracking-tight">Ajustes</h2>

      <Group label="Aparência">
        <Segmented
          id="mode"
          value={prefs.mode}
          options={[
            { value: 'escuro', label: 'Escuro', icon: Moon },
            { value: 'claro', label: 'Claro', icon: Sun },
          ]}
          onChange={(mode) => patch({ mode })}
        />
        <div className="grid grid-cols-6 gap-2 pt-1">
          {PALETTE_ORDER.map((id) => {
            const p = PALETTES[id];
            const on = prefs.palette === id;
            return (
              <button key={id} type="button" aria-label={p.name} aria-pressed={on} onClick={() => patch({ palette: id })} className="flex flex-col items-center gap-1">
                <span className={`h-9 w-9 rounded-full transition-shadow ${on ? 'ring-2 ring-accent ring-offset-2 ring-offset-[var(--shell)]' : ''}`} style={{ background: `linear-gradient(135deg, ${p.colors.bodyTop}, ${p.colors.accent})` }} />
                <span className={`text-[11px] ${on ? 'text-ink' : 'text-muted'}`}>{p.name}</span>
              </button>
            );
          })}
        </div>
      </Group>

      <Group label="Modelo">
        <Segmented id="model" value={prefs.model} options={MODELS.map((m) => ({ value: m.id, label: m.name }))} onChange={(model) => patch({ model })} />
      </Group>

      <Group label="Comportamento">
        <Toggle label="Acompanhar a inclinação" on={prefs.tilt} set={(v) => patch({ tilt: v })} />
        <Toggle label="Vibração" on={prefs.haptics} set={(v) => patch({ haptics: v })} />
        <Toggle label="Sempre ligado ao carregar" on={prefs.standbyOnCharge} set={(v) => patch({ standbyOnCharge: v })} />
      </Group>

      <Group label="Conexão">
        <div className="m-card flex items-center justify-between px-4 py-3 text-[15px]">
          <span>{bridge.link.pc}</span>
          <span className="text-[13px] text-muted">{bridge.link.base.replace(/^https?:\/\//, '')}</span>
        </div>
        <button type="button" className="m-btn m-btn-danger" onClick={onDisconnect}>
          <LogOut className="h-4 w-4" /> Desconectar
        </button>
      </Group>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <span className="m-label">{label}</span>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ id, value, options, onChange }: { id: string; value: T; options: { value: T; label: string; icon?: typeof Sun }[]; onChange: (v: T) => void }) {
  return (
    <div className="flex rounded-2xl bg-surface-2 p-1">
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)} className="relative flex flex-1 items-center justify-center gap-1.5 py-2 text-[14px]">
          {value === o.value && <motion.span layoutId={`seg-${id}`} className="absolute inset-0 rounded-xl bg-surface-3 shadow-sm" transition={spring} />}
          {o.icon && <o.icon className="relative h-4 w-4" />}
          <span className={`relative ${value === o.value ? 'text-ink' : 'text-muted'}`}>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, on, set }: { label: string; on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} onClick={() => set(!on)} className="m-card flex items-center justify-between px-4 py-3 text-left text-[15px]">
      {label}
      <span className={`relative h-6 w-10 rounded-full transition-colors duration-300 ${on ? 'bg-accent' : 'bg-surface-3'}`}>
        <motion.span className="absolute top-1 h-4 w-4 rounded-full bg-white shadow" animate={{ left: on ? 20 : 4 }} transition={spring} />
      </span>
    </button>
  );
}
