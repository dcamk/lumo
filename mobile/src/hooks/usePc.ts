// Estado do PC (uso, mídia) e se a ponte está respondendo
import { useCallback, useEffect, useState } from 'react';
import type { Bridge, PcStatus } from '../lib/bridge';

export function usePc(bridge: Bridge | null, every = 4000) {
  const [status, setStatus] = useState<PcStatus | null>(null);
  const [online, setOnline] = useState(true);

  const refresh = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.get<PcStatus>('/api/status'));
      setOnline(true);
    } catch {
      setOnline(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    void refresh();
    let id = window.setInterval(refresh, every);
    // Volta do segundo plano: atualiza na hora; escondido, não gasta bateria
    const onVis = () => {
      clearInterval(id);
      if (!document.hidden) {
        void refresh();
        id = window.setInterval(refresh, every);
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [bridge, every, refresh]);

  return { status, online, refresh, setStatus };
}
