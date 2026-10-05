import { Gem, Shapes, Volume2 } from 'lucide-react';
import { sound } from '../../audio/SoundEngine';
import { press } from '../../lib/motion';
import { PALETTE_ORDER, PALETTES, type Palette, type PaletteId, type VoiceStyle } from '../../theme/palettes';
import type { Look } from '../../theme/store';
import { Lumo3D } from '../Lumo3D';

interface Props {
  palette: Palette;
  voice: 'auto' | VoiceStyle;
  look: Look;
  onLook: (l: Look) => void;
  onPalette: (id: PaletteId) => void;
  onVoice: (v: 'auto' | VoiceStyle) => void;
}

const VOICES: { key: 'auto' | VoiceStyle; label: string; hint: string }[] = [
  { key: 'auto', label: 'Da paleta', hint: 'Cada paleta tem o seu som' },
  { key: 'discreto', label: 'Discreto', hint: 'Sinos suaves de interface' },
  { key: 'terminal', label: 'Terminal', hint: 'Bips secos, estilo hacker' },
  { key: 'criatura', label: 'Criatura', hint: 'A voz fofa original' },
];

const LOOKS: { key: Look; label: string; hint: string; icon: typeof Gem }[] = [
  { key: 'classico', label: 'Clássico', hint: 'Desenho limpo e chapado', icon: Shapes },
  { key: 'realista', label: 'Realista', hint: 'Vidro polido com reflexos e brilho de LED', icon: Gem },
];

const TRAITS: { key: keyof Palette['traits']; label: string }[] = [
  { key: 'formal', label: 'Formalidade' },
  { key: 'energia', label: 'Energia' },
  { key: 'ousadia', label: 'Ousadia' },
];

function Swatch({ p, active, onPick }: { p: Palette; active: boolean; onPick: (el: HTMLElement) => void }) {
  const c = p.colors;
  return (
    <button
      type="button"
      aria-pressed={active}
      aria-label={`Paleta ${p.name} — ${p.tagline}`}
      title={`${p.name} · ${p.tagline}`}
      onClick={(e) => onPick(e.currentTarget)}
      className="group flex flex-col items-center gap-1 rounded-xl px-1 pt-1.5 pb-1 transition-colors hover:bg-white/[0.05] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent-3)]"
    >
      {/* miniatura: corpo do Lumo na cor da paleta, olho e luz de destaque */}
      <span
        className="relative block w-9 h-9 rounded-[12px] transition-transform duration-200 group-hover:scale-105"
        style={{
          background: `linear-gradient(180deg, ${c.bodyTop}, ${c.bodyBottom})`,
          boxShadow: active ? `0 0 0 2px ${c.shell}, 0 0 0 4px ${c.accent}, 0 0 16px -2px ${c.accent}` : `inset 0 0 0 1px ${c.accent}55`,
        }}
      >
        <span className="absolute left-[30%] top-[28%] w-[8%] h-[34%] rounded-full" style={{ background: c.eye }} />
        <span className="absolute right-[30%] top-[28%] w-[8%] h-[34%] rounded-full" style={{ background: c.eye }} />
        <span className="absolute left-[22%] right-[22%] bottom-[14%] h-[6%] rounded-full" style={{ background: c.accent }} />
      </span>
      <span className={`text-[10px] leading-none font-semibold ${active ? 'text-ink' : 'text-slate-400'}`}>{p.name}</span>
    </button>
  );
}

function Trait({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-[68px] shrink-0 text-[10px] text-slate-400">{label}</span>
      <span className="relative flex-1 h-1 rounded-full bg-white/10 overflow-hidden" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value * 100)}>
        <span className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-500 ease-out" style={{ width: `${value * 100}%` }} />
      </span>
    </div>
  );
}

/** Painel de estilo: escolhe a paleta (cores + personalidade) com prévia 3D ao vivo */
export function StyleTab({ palette, voice, look, onLook, onPalette, onVoice }: Props) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar pt-2 pr-1 flex flex-col gap-2.5">
      <section data-anim="item" className="flex gap-3 items-stretch">
        <Lumo3D palette={palette} realistic={look === 'realista'} className="shrink-0 w-[124px] h-[124px] rounded-2xl bg-surface-2 border border-[color:var(--line)] overflow-hidden" />
        <div className="min-w-0 flex-1 flex flex-col gap-1.5">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm font-bold text-ink">{palette.name}</h3>
            <span className="text-[10px] uppercase tracking-wider text-accent">{palette.tagline}</span>
          </div>
          <p className="text-[11px] leading-snug text-slate-300">{palette.vibe}</p>
          <div className="mt-auto flex flex-col gap-1">
            {TRAITS.map((t) => (
              <Trait key={t.key} label={t.label} value={palette.traits[t.key]} />
            ))}
          </div>
        </div>
      </section>

      <section data-anim="item" aria-label="Paletas">
        <div className="grid grid-cols-6 gap-0.5">
          {PALETTE_ORDER.map((id) => (
            <Swatch
              key={id}
              p={PALETTES[id]}
              active={palette.id === id}
              onPick={(el) => {
                press(el);
                onPalette(id);
              }}
            />
          ))}
        </div>
      </section>

      <section data-anim="item" className="flex items-center gap-1.5 flex-wrap" aria-label="Visual do corpo">
        <Gem className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden />
        <span className="text-[10px] text-slate-400 mr-1">Visual</span>
        {LOOKS.map((l) => {
          const on = look === l.key;
          const Icon = l.icon;
          return (
            <button
              key={l.key}
              type="button"
              aria-pressed={on}
              title={l.hint}
              onClick={() => {
                onLook(l.key);
                sound.playPop();
              }}
              className={`h-6 px-2.5 inline-flex items-center gap-1 rounded-full text-[10px] font-medium border transition-colors ${
                on ? 'bg-accent text-[var(--on-accent)] border-transparent' : 'border-[color:var(--line)] text-slate-300 hover:bg-white/[0.06]'
              }`}
            >
              <Icon className="w-3 h-3" aria-hidden />
              {l.label}
            </button>
          );
        })}
      </section>

      <section data-anim="item" className="flex items-center gap-1.5 flex-wrap" aria-label="Voz dos sons">
        <Volume2 className="w-3.5 h-3.5 text-slate-400 shrink-0" aria-hidden />
        <span className="text-[10px] text-slate-400 mr-1">Sons</span>
        {VOICES.map((v) => {
          const on = voice === v.key;
          return (
            <button
              key={v.key}
              type="button"
              aria-pressed={on}
              title={v.hint}
              onClick={() => {
                onVoice(v.key);
                sound.playPop();
              }}
              className={`h-6 px-2.5 rounded-full text-[10px] font-medium border transition-colors ${
                on ? 'bg-accent text-[var(--on-accent)] border-transparent' : 'border-[color:var(--line)] text-slate-300 hover:bg-white/[0.06]'
              }`}
            >
              {v.label}
            </button>
          );
        })}
      </section>
    </div>
  );
}
