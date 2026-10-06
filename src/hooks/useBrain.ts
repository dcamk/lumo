import { useCallback, useEffect, useRef, useState } from 'react';
import { PROVIDERS, providerConfig } from '../lib/providers';
import { invoke, isTauri, tryInvoke } from '../lib/tauri';
import type { Settings } from '../types';

/** Um modelo do pool, como o backend o mede (src-tauri/src/brain/pool.rs) */
export interface PoolSlot {
  key: string;
  provider: string;
  label: string;
  model: string;
  local: boolean;
  /** null = ainda não testado */
  ok: boolean | null;
  tools: boolean | null;
  latency_ms: number | null;
  error: string;
  checked_at: number;
  cooldown_secs: number;
  capacity: number;
  quality: number;
  ctx_k: number;
  rate: string;
  score: number;
}

export interface Fact {
  id: number;
  text: string;
  ts: number;
}

export interface Skill {
  name: string;
  description: string;
}

export interface Plugin {
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  trusted: boolean;
  running: boolean;
  tools: string[];
  error: string;
}

/**
 * Mantém o backend (cérebro) a par das chaves/modelos e acompanha o pool de provedores.
 * O backend testa os provedores sozinho, em segundo plano; aqui só se mostra o resultado.
 */
export function useBrain(settings: Settings, watch: boolean) {
  const [pool, setPool] = useState<PoolSlot[]>([]);
  const [testing, setTesting] = useState(false);

  // Envia a configuração quando muda (com um respiro para não reenviar a cada tecla)
  const sig = JSON.stringify(PROVIDERS.map((p) => providerConfig(settings, p.id))) + settings.provider;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (!isTauri()) return;
    const id = window.setTimeout(() => {
      const s = settingsRef.current;
      void tryInvoke('brain_configure', {
        providers: PROVIDERS.map((p) => {
          const c = providerConfig(s, p.id);
          return { id: p.id, api_key: c.apiKey, model: s.providers[p.id]?.model?.trim() ?? '', endpoint: s.providers[p.id]?.endpoint?.trim() ?? '' };
        }),
        preferred: s.provider,
      }).then(() => refresh());
    }, 600);
    return () => window.clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const refresh = useCallback(async () => {
    const list = await tryInvoke<PoolSlot[]>('pool_status');
    if (list) setPool(list);
  }, []);

  // Com a tela de IA aberta, atualiza o status a cada poucos segundos
  useEffect(() => {
    if (!watch || !isTauri()) return;
    void refresh();
    const id = window.setInterval(refresh, 4000);
    return () => window.clearInterval(id);
  }, [watch, refresh]);

  const test = useCallback(async () => {
    setTesting(true);
    const list = await tryInvoke<PoolSlot[]>('pool_test');
    if (list) setPool(list);
    setTesting(false);
  }, []);

  return { pool, testing, test };
}

/** Memória, skills e plugins (tela Config → Agente) */
export function useAgentKit(active: boolean) {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  const [error, setError] = useState('');

  const reload = useCallback(async () => {
    const [f, s, p] = await Promise.all([
      tryInvoke<Fact[]>('memory_list'),
      tryInvoke<Skill[]>('skill_list'),
      tryInvoke<Plugin[]>('plugin_list'),
    ]);
    if (f) setFacts(f);
    if (s) setSkills(s);
    if (p) setPlugins(p);
  }, []);

  useEffect(() => {
    if (!active) return;
    void reload();
    const id = window.setInterval(reload, 3000); // plugins sobem em segundo plano
    return () => window.clearInterval(id);
  }, [active, reload]);

  const run = useCallback(
    async <T,>(cmd: string, args: Record<string, unknown>): Promise<T | null> => {
      setError('');
      try {
        const r = await invoke<T>(cmd, args);
        await reload();
        return r;
      } catch (err) {
        setError(String(err));
        return null;
      }
    },
    [reload]
  );

  return {
    facts,
    skills,
    plugins,
    error,
    addFact: (text: string) => run<string>('memory_add', { text }),
    forgetFact: (id: number) => run<string>('memory_forget', { id }),
    installSkill: (source: string) => run<string[]>('skill_install', { source }),
    removeSkill: (name: string) => run('skill_remove', { name }),
    addPlugin: (name: string, command: string, args: string[]) => run('plugin_add', { name, command, args, env: {} }),
    removePlugin: (name: string) => run('plugin_remove', { name }),
    setPlugin: (name: string, patch: { enabled?: boolean; trusted?: boolean }) => run('plugin_set', { name, ...patch }),
  };
}
