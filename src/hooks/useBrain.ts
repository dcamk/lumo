import { useEffect, useRef } from 'react';
import { PROVIDERS } from '../lib/providers';
import { tryInvoke } from '../lib/tauri';
import type { Settings } from '../types';

/**
 * Manda as chaves/modelos para o cérebro (src-tauri/src/brain) quando mudam. Só vão os
 * valores que o usuário salvou: sem modelo escolhido, o cérebro usa o padrão do
 * provedor e troca sozinho se ele sair do ar.
 */
export function useBrainConfig(settings: Settings) {
  const providers = PROVIDERS.map((p) => {
    const saved = settings.providers[p.id] ?? {};
    return { id: p.id, api_key: saved.apiKey?.trim() ?? '', model: saved.model?.trim() ?? '', endpoint: saved.endpoint?.trim() ?? '' };
  });
  const key = JSON.stringify(providers) + settings.provider;
  const latest = useRef({ providers, preferred: settings.provider });
  latest.current = { providers, preferred: settings.provider };

  useEffect(() => {
    // espera a digitação da chave terminar
    const id = window.setTimeout(() => void tryInvoke('brain_configure', latest.current), 600);
    return () => window.clearTimeout(id);
  }, [key]);
}

export interface PoolInfo {
  key: string;
  provider: string;
  label: string;
  model: string;
  local: boolean;
  ok: boolean | null;
  tools: boolean | null;
  latency_ms: number | null;
  error: string;
  cooldown_secs: number;
  rate: string;
}
