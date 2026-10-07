// Controle do PC: uso do sistema, mídia, links e área de transferência
import { ClipboardCopy, ExternalLink, Music2, Pause, Play, SendHorizontal, SkipBack, SkipForward } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useState } from 'react';
import { formatBytes, haptic, type Bridge, type Media, type PcStatus } from '../lib/bridge';

interface Props {
  bridge: Bridge;
  status: PcStatus | null;
  online: boolean;
  setMedia: (m: Media | null) => void;
  toast: (t: string) => void;
}

export function Control({ bridge, status, online, setMedia, toast }: Props) {
  const s = status?.stats;
  const media = status?.media ?? null;
  const [url, setUrl] = useState('');
  const [clip, setClip] = useState('');
  const [fromPc, setFromPc] = useState(() => sessionStorage.getItem('lumo.mobile.pcclip') ?? '');

  useEffect(() => sessionStorage.removeItem('lumo.mobile.pcclip'), []);

  const run = async <T,>(fn: () => Promise<T>, ok?: string) => {
    haptic(10);
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  const mediaAction = async (action: 'PlayPause' | 'Next' | 'Previous') => {
    const r = await run(() => bridge.post<{ media: Media | null }>('/api/media', { action }));
    if (r) setMedia(r.media);
  };

  const openLink = async () => {
    let u = url.trim();
    if (!u) return;
    if (!/^(https?:|mailto:)/i.test(u)) u = `https://${u}`;
    if (await run(() => bridge.post('/api/open', { url: u }), 'Abrindo no PC.')) setUrl('');
  };

  const sendClip = async () => {
    if (!clip.trim()) return;
    if (await run(() => bridge.post('/api/clipboard', { text: clip }), 'Copiado no PC.')) setClip('');
  };

  const getClip = async () => {
    const r = await run(() => bridge.get<{ text: string }>('/api/clipboard'));
    if (!r) return;
    setFromPc(r.text);
    try {
      await navigator.clipboard.writeText(r.text);
      toast('Copiado aqui também.');
    } catch {
      /* http na rede local: o navegador não deixa copiar sozinho; o texto fica abaixo */
    }
  };

  return (
    <div className="m-scroll flex h-full flex-col gap-4 px-4 pb-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-semibold tracking-tight">Controle</h2>
      </div>

      {!online && <p className="m-card border-danger p-3 text-[14px] text-danger">O PC não está respondendo. Ele está ligado e na mesma rede?</p>}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Ring label="CPU" value={s?.cpu ?? 0} text={s ? `${Math.round(s.cpu)}%` : '—'} sub={s ? `${s.cores} núcleos` : ''} />
        <Ring label="Memória" value={s ? (s.mem_used / Math.max(1, s.mem_total)) * 100 : 0} text={s ? `${Math.round((s.mem_used / Math.max(1, s.mem_total)) * 100)}%` : '—'} sub={s ? `${formatBytes(s.mem_used)} de ${formatBytes(s.mem_total)}` : ''} />
        <Ring label="Disco" value={s ? (s.disk_used / Math.max(1, s.disk_total)) * 100 : 0} text={s ? `${Math.round((s.disk_used / Math.max(1, s.disk_total)) * 100)}%` : '—'} sub={s ? `${formatBytes(s.disk_total - s.disk_used)} livres` : ''} />
        {s?.battery != null ? (
          <Ring label="Bateria" value={s.battery} text={`${s.battery}%`} sub={s.charging ? 'carregando' : 'na bateria'} good />
        ) : (
          <Ring label="Temperatura" value={s?.temp ?? 0} text={s?.temp != null ? `${Math.round(s.temp)}°C` : '—'} sub={s ? `↓ ${formatBytes(s.net_down)}/s` : ''} />
        )}
      </div>

      <div className="m-card p-4">
        <div className="flex items-center gap-3">
          <motion.div animate={media?.playing ? { rotate: 360 } : { rotate: 0 }} transition={media?.playing ? { repeat: Infinity, duration: 6, ease: 'linear' } : { duration: 0.4 }} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-surface-3">
            <Music2 className="h-5 w-5 text-accent" />
          </motion.div>
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold">{media?.title || 'Nada tocando'}</div>
            <div className="truncate text-[13px] text-muted">{media ? [media.artist, media.player].filter(Boolean).join(' · ') : 'Abra um player no PC (Spotify, navegador…)'}</div>
          </div>
        </div>
        <div className="mt-3 grid grid-cols-3 gap-2">
          <button type="button" className="m-btn" onClick={() => void mediaAction('Previous')} disabled={!media} aria-label="Anterior">
            <SkipBack className="h-5 w-5" />
          </button>
          <button type="button" className="m-btn m-btn-solid" onClick={() => void mediaAction('PlayPause')} disabled={!media} aria-label={media?.playing ? 'Pausar' : 'Tocar'}>
            {media?.playing ? <Pause className="h-5 w-5" /> : <Play className="h-5 w-5" />}
          </button>
          <button type="button" className="m-btn" onClick={() => void mediaAction('Next')} disabled={!media} aria-label="Próxima">
            <SkipForward className="h-5 w-5" />
          </button>
        </div>
      </div>

      <form
        className="m-card flex flex-col gap-2 p-4"
        onSubmit={(e) => {
          e.preventDefault();
          void openLink();
        }}
      >
        <span className="m-label flex items-center gap-1.5">
          <ExternalLink className="h-3.5 w-3.5" /> Abrir link no PC
        </span>
        <div className="flex gap-2">
          <input className="m-input" inputMode="url" autoCapitalize="off" placeholder="youtube.com/…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="m-btn m-btn-solid w-[46px] shrink-0 p-0" disabled={!url.trim()} aria-label="Abrir">
            <SendHorizontal className="h-5 w-5" />
          </button>
        </div>
      </form>

      <div className="m-card flex flex-col gap-2 p-4">
        <span className="m-label flex items-center gap-1.5">
          <ClipboardCopy className="h-3.5 w-3.5" /> Área de transferência
        </span>
        <textarea className="m-input min-h-20 resize-none" placeholder="Texto para colar no PC" value={clip} onChange={(e) => setClip(e.target.value)} />
        <div className="grid grid-cols-2 gap-2">
          <button type="button" className="m-btn" onClick={() => void getClip()}>
            Pegar do PC
          </button>
          <button type="button" className="m-btn m-btn-solid" onClick={() => void sendClip()} disabled={!clip.trim()}>
            Mandar ao PC
          </button>
        </div>
        {fromPc && (
          <motion.div initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }}>
            <span className="text-[12px] text-muted">Do PC (toque e segure para copiar):</span>
            <textarea readOnly className="m-input mt-1 min-h-20 resize-none font-mono text-[13px]" value={fromPc} onFocus={(e) => e.target.select()} />
          </motion.div>
        )}
      </div>
    </div>
  );
}

/** Anel de uso com cor por faixa (verde → âmbar → vermelho) */
function Ring({ label, value, text, sub, good = false }: { label: string; value: number; text: string; sub: string; good?: boolean }) {
  const r = 30;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const hot = good ? v < 20 : v > 85;
  const warm = good ? v < 40 : v > 65;
  const color = hot ? 'var(--danger)' : warm ? 'var(--warn)' : 'var(--accent)';
  return (
    <div className="m-card flex flex-col items-center p-3">
      <svg viewBox="0 0 80 80" className="h-20 w-20 -rotate-90" aria-hidden>
        <circle cx="40" cy="40" r={r} fill="none" stroke="var(--line)" strokeWidth="7" />
        <circle className="m-ring" cx="40" cy="40" r={r} fill="none" stroke={color} strokeWidth="7" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - v / 100)} />
      </svg>
      <div className="-mt-[54px] mb-[22px] text-lg font-bold tabular-nums">{text}</div>
      <div className="text-[13px] font-semibold">{label}</div>
      <div className="h-4 truncate text-[11px] text-muted">{sub}</div>
    </div>
  );
}
