import { useEffect, useRef, useState } from 'react';
import { isTauri, tryInvoke } from '../lib/tauri';

export interface SystemStats {
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
  temp: number | null;
  battery: number | null;
  charging: boolean;
  net_down: number;
  net_up: number;
  uptime: number;
  load: number;
  cores: number;
  top: { name: string; cpu: number; mem: number }[];
}

export interface MediaStatus {
  player: string;
  playing: boolean;
  title: string;
  artist: string;
}

export interface SystemAlert {
  key: 'mem' | 'disk' | 'temp' | 'battery';
  title: string;
  text: string;
}

const pct = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);

/** Limites dos avisos (cada aviso só repete depois de voltar ao normal) */
function alertsFor(s: SystemStats): SystemAlert[] {
  const out: SystemAlert[] = [];
  const mem = pct(s.mem_used, s.mem_total);
  const disk = pct(s.disk_used, s.disk_total);
  if (mem >= 92) {
    const heavy = s.top[0] ? ` — ${s.top[0].name} usa ${s.top[0].mem.toFixed(0)}%` : '';
    out.push({ key: 'mem', title: 'Memória quase cheia', text: `${mem.toFixed(0)}% da RAM em uso${heavy}` });
  }
  if (disk >= 95) out.push({ key: 'disk', title: 'Disco quase cheio', text: `${formatBytes(s.disk_total - s.disk_used)} livres em /` });
  if (s.temp != null && s.temp >= 90) out.push({ key: 'temp', title: 'Temperatura alta', text: `${s.temp.toFixed(0)} °C` });
  if (s.battery != null && s.battery <= 15 && !s.charging) {
    out.push({ key: 'battery', title: 'Bateria fraca', text: `${s.battery}% — conecte o carregador` });
  }
  return out;
}

/**
 * Uso do sistema. `live` (aba Linux aberta) = a cada 2 s; senão a cada 30 s, só para
 * os avisos. `onAlert` dispara uma vez quando um limite é ultrapassado.
 */
export function useSystemStats(live: boolean, alertsOn: boolean, onAlert: (a: SystemAlert) => void) {
  const [stats, setStats] = useState<SystemStats | null>(null);
  const active = useRef(new Set<string>());
  const onAlertRef = useRef(onAlert);
  onAlertRef.current = onAlert;

  useEffect(() => {
    if (!isTauri() || (!live && !alertsOn)) return;
    let alive = true;
    const tick = async () => {
      const s = await tryInvoke<SystemStats>('system_stats');
      if (!alive || !s) return;
      setStats(s);
      if (!alertsOn) return;
      const now = alertsFor(s);
      for (const a of now) if (!active.current.has(a.key)) onAlertRef.current(a);
      active.current = new Set(now.map((a) => a.key));
    };
    void tick();
    const id = window.setInterval(tick, live ? 2000 : 30_000);
    return () => {
      alive = false;
      window.clearInterval(id);
    };
  }, [live, alertsOn]);

  return stats;
}

/** Player de mídia ativo (MPRIS), atualizado enquanto `live` */
export function useMedia(live: boolean) {
  const [media, setMedia] = useState<MediaStatus | null>(null);
  const refresh = async () => setMedia(await tryInvoke<MediaStatus | null>('media_status'));

  useEffect(() => {
    if (!live || !isTauri()) return;
    void refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [live]);

  const control = async (action: 'PlayPause' | 'Next' | 'Previous') => {
    await tryInvoke('media_control', { action });
    window.setTimeout(refresh, 250);
  };

  return { media, control };
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

export function formatUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

export { pct };
