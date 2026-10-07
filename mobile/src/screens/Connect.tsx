// Pareamento: o QR do PC já traz endereço e PIN (#pair=123456); sem ele, digita-se o PIN
// (e o endereço, no app nativo ou fora da rede do PC).
import { Laptop, Link2, Loader2, Wifi } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { Palette } from '../../../src/theme/palettes';
import { defaultBase, haptic, normalizeBase, pair, type Link } from '../lib/bridge';
import { LumoStage, type ModelId, type Poke } from '../three/LumoStage';

interface Props {
  palette: Palette;
  model: ModelId;
  onLinked: (link: Link) => void;
  /** Motivo de ter voltado para cá (ex.: o PC esqueceu este aparelho) */
  reason?: string;
}

function pinFromHash(): string {
  const m = window.location.hash.match(/pair=(\d{6})/);
  return m ? m[1] : '';
}

export function Connect({ palette, model, onLinked, reason }: Props) {
  const fixed = defaultBase();
  const [base, setBase] = useState(fixed);
  const [pin, setPin] = useState(pinFromHash);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(reason ?? '');
  const [poke, setPoke] = useState<Poke | null>(null);
  const tried = useRef(false);

  const go = async (pinValue = pin) => {
    const b = normalizeBase(base);
    if (!b) return setError('Digite o endereço que aparece no PC (ex.: 192.168.0.10).');
    if (!/^\d{6}$/.test(pinValue)) return setError('O PIN tem 6 números.');
    setBusy(true);
    setError('');
    try {
      const link = await pair(b, pinValue);
      haptic(20);
      setPoke({ kind: 'joy', n: Date.now() });
      history.replaceState(null, '', window.location.pathname);
      window.setTimeout(() => onLinked(link), 650);
    } catch (err) {
      haptic(60);
      setPoke({ kind: 'nod', n: Date.now() });
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  // Veio do QR: pareia sozinho
  useEffect(() => {
    if (!tried.current && fixed && /^\d{6}$/.test(pin)) {
      tried.current = true;
      void go(pin);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="relative z-10 mx-auto flex h-full w-full max-w-5xl flex-col items-center justify-center gap-6 px-6 md:flex-row md:gap-12" style={{ paddingTop: 'calc(var(--safe-top) + 16px)', paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}>
      <LumoStage model={model} palette={palette} poke={poke} mood={busy ? 'thinking' : 'idle'} className="h-[34vh] w-full max-w-sm md:h-[60vh] md:flex-1" />
      <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ type: 'spring', stiffness: 220, damping: 24 }} className="m-card w-full max-w-sm p-6 md:flex-1">
        <h1 className="text-2xl font-bold">Conectar ao PC</h1>
        <p className="mt-1 text-[15px] text-muted">
          No Lumo do computador, abra <b className="text-ink">Config → Celular</b>, ligue a ponte e aponte a câmera para o QR. Ou digite o PIN abaixo.
        </p>

        <form
          className="mt-5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          {!fixed && (
            <label className="flex flex-col gap-1.5">
              <span className="m-label flex items-center gap-1.5">
                <Laptop className="h-3.5 w-3.5" /> Endereço do PC
              </span>
              <input className="m-input" inputMode="url" autoCapitalize="off" autoCorrect="off" placeholder="192.168.0.10" value={base} onChange={(e) => setBase(e.target.value)} />
            </label>
          )}
          <label className="flex flex-col gap-1.5">
            <span className="m-label flex items-center gap-1.5">
              <Link2 className="h-3.5 w-3.5" /> PIN de 6 números
            </span>
            <input
              className="m-input text-center font-mono text-2xl tracking-[0.5em]"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="••••••"
              value={pin}
              onChange={(e) => {
                const v = e.target.value.replace(/\D/g, '').slice(0, 6);
                setPin(v);
                if (v.length === 6 && (fixed || base)) void go(v);
              }}
            />
          </label>
          {error && (
            <motion.p initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} className="text-[14px] text-danger" role="alert">
              {error}
            </motion.p>
          )}
          <button type="submit" className="m-btn m-btn-solid mt-1" disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
            {busy ? 'Conectando…' : 'Conectar'}
          </button>
        </form>
        <p className="mt-4 text-[13px] text-muted">O celular e o PC precisam estar na mesma rede Wi-Fi.</p>
      </motion.div>
    </div>
  );
}
