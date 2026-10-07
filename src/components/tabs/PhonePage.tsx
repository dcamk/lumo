// Config → Celular: liga a Ponte Lumo (src-tauri/src/bridge.rs) e mostra o QR de pareamento.
// O celular abre o endereço do QR, pareia com o PIN e passa a usar a IA deste PC.
import { FolderOpen, RefreshCw, Smartphone, X } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { invoke, isTauri, listen } from '../../lib/tauri';

interface DeviceInfo {
  id: string;
  name: string;
  paired_at: number;
  last_seen: number;
}

interface BridgeStatus {
  enabled: boolean;
  running: boolean;
  port: number;
  urls: string[];
  pair_url: string;
  pin: string;
  pin_expires: number;
  qr_svg: string;
  devices: DeviceInfo[];
  shared_dir: string;
}

const smallBtn =
  'shrink-0 inline-flex items-center gap-1 px-2.5 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white text-[11px] disabled:opacity-40 transition-colors';

const ago = (secs: number) => {
  if (!secs) return 'nunca';
  const d = Math.max(0, Date.now() / 1000 - secs);
  if (d < 90) return 'agora';
  if (d < 3600) return `há ${Math.round(d / 60)} min`;
  if (d < 86400) return `há ${Math.round(d / 3600)} h`;
  return new Date(secs * 1000).toLocaleDateString('pt-BR');
};

export function PhonePage() {
  const [st, setSt] = useState<BridgeStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now() / 1000);

  const refresh = useCallback(async () => {
    try {
      setSt(await invoke<BridgeStatus>('bridge_status'));
    } catch (err) {
      setError(String(err));
    }
  }, []);

  useEffect(() => {
    if (!isTauri()) return;
    void refresh();
    // Celular pareado, arquivo recebido…: o backend avisa
    const off = listen('bridge-changed', () => void refresh());
    const tick = window.setInterval(() => setNow(Date.now() / 1000), 1000);
    return () => {
      void off.then((fn) => fn());
      window.clearInterval(tick);
    };
  }, [refresh]);

  // PIN expirou: o backend gera outro ao pedir o status
  useEffect(() => {
    if (st?.running && st.pin_expires && now > st.pin_expires) void refresh();
  }, [now, st, refresh]);

  const run = async (fn: () => Promise<BridgeStatus | void>) => {
    setBusy(true);
    setError('');
    try {
      const r = await fn();
      if (r) setSt(r);
    } catch (err) {
      setError(String(err));
    }
    setBusy(false);
  };

  if (!isTauri()) return <p className="text-slate-500">Disponível no app instalado.</p>;
  if (!st) return null;

  const left = Math.max(0, Math.round(st.pin_expires - now));

  return (
    <>
      <div data-anim="item" className="flex items-center gap-2 min-h-7">
        <Smartphone className="w-3.5 h-3.5 text-slate-400" />
        <span className="flex-1 text-slate-300">Usar o Lumo no celular ou tablet (mesma rede Wi-Fi)</span>
        <button
          type="button"
          role="switch"
          aria-checked={st.enabled}
          aria-label="Ponte com o celular"
          disabled={busy}
          onClick={() => void run(() => invoke<BridgeStatus>('bridge_set', { enabled: !st.enabled }))}
          className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${st.enabled ? 'lumo-pill' : 'bg-white/15'}`}
        >
          <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${st.enabled ? 'translate-x-5' : 'translate-x-1'}`} />
        </button>
      </div>
      {error && <p className="text-[10px] text-amber-400">{error}</p>}

      {st.running && (
        <div data-anim="item" className="flex gap-3 items-start">
          {st.qr_svg && (
            // QR gerado no próprio PC (SVG do backend): fundo branco para a câmera ler
            <div className="shrink-0 w-[112px] h-[112px] rounded-xl bg-white p-1.5 [&>svg]:w-full [&>svg]:h-full" dangerouslySetInnerHTML={{ __html: st.qr_svg }} aria-label="QR code de pareamento" />
          )}
          <div className="flex-1 min-w-0 flex flex-col gap-1">
            <span className="text-slate-400">Aponte a câmera do celular para o QR, ou abra no navegador dele:</span>
            {st.urls.length ? (
              st.urls.map((u) => (
                <code key={u} className="font-mono text-[12px] text-white select-all">
                  {u}
                </code>
              ))
            ) : (
              <span className="text-amber-300">Não achei o endereço deste PC na rede. Ele está conectado ao Wi-Fi/cabo?</span>
            )}
            <div className="flex items-center gap-2 mt-0.5">
              <span className="text-slate-400">PIN</span>
              <span className="font-mono text-[16px] tracking-[0.25em] text-white">{st.pin}</span>
              <span className="text-[10px] text-slate-500">{left > 0 ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : ''}</span>
              <button type="button" className={smallBtn} disabled={busy} onClick={() => void run(() => invoke<BridgeStatus>('bridge_new_pin'))} title="Gerar outro PIN">
                <RefreshCw className="w-3 h-3" /> Novo
              </button>
            </div>
          </div>
        </div>
      )}

      {st.enabled && !st.running && <p className="text-[10px] text-amber-400">A ponte não subiu. Veja se outra coisa está usando a porta {st.port}.</p>}

      {st.devices.length > 0 && (
        <div data-anim="item" className="flex flex-col gap-1 mt-1">
          <span className="text-slate-400">Aparelhos pareados</span>
          {st.devices.map((d) => (
            <div key={d.id} className="flex items-center gap-2 px-2 py-1 rounded-lg bg-white/[0.04]">
              <Smartphone className="w-3 h-3 text-slate-400" />
              <span className="flex-1 truncate text-white">{d.name}</span>
              <span className="text-[10px] text-slate-500">visto {ago(d.last_seen)}</span>
              <button type="button" className="p-0.5 rounded text-slate-500 hover:text-rose-300" title="Remover este aparelho" aria-label={`Remover ${d.name}`} onClick={() => void run(() => invoke<BridgeStatus>('bridge_forget', { id: d.id }))}>
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      <div data-anim="item" className="flex items-center gap-2 min-h-7">
        <span className="flex-1 truncate text-slate-400" title={st.shared_dir}>
          Arquivos trocados: <span className="text-slate-300">{st.shared_dir.replace(/^\/home\/[^/]+/, '~')}</span>
        </span>
        <button type="button" className={smallBtn} onClick={() => void invoke('bridge_open_shared').catch((e) => setError(String(e)))}>
          <FolderOpen className="w-3 h-3" /> Abrir
        </button>
      </div>
      <p className="text-[10px] text-slate-500 leading-snug">
        O celular usa a IA configurada aqui (as chaves não saem do PC) e todo comando pede aprovação na tela dele. A conexão é na rede local, sem criptografia: use em redes de confiança.
      </p>
    </>
  );
}
