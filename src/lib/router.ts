// Escolhe o provedor de IA de acordo com a disponibilidade.
//
// Ordem: o configurado → outros gratuitos com chave → LLM7 (sem chave) → modelos do
// Ollama local que aceitam ferramentas (os menores primeiro: respondem mais rápido).
// Quem falha fica "de castigo" por alguns minutos (limite da cota, fora do ar, lento)
// e é pulado nas próximas mensagens; quem responde sai do castigo.
import { tryInvoke } from './tauri';
import { PROVIDERS, presetOf, providerConfig, providerReady } from './providers';
import type { ProviderId, Settings } from '../types';

export interface Candidate {
  provider: ProviderId;
  /** Modelo (sobrepõe o configurado — usado para trocar de modelo local) */
  model: string;
  label: string;
  local: boolean;
  /** Tempo máximo por resposta do modelo (s) */
  timeout: number;
}

interface LocalModel {
  name: string;
  size: number;
  tools: boolean;
  embedding: boolean;
}

/** Nuvem responde em segundos; local pode precisar carregar o modelo na memória */
const CLOUD_TIMEOUT = 45;
const LOCAL_TIMEOUT = 90;
const LOCAL_ALTERNATIVES = 2;

const cooldown = new Map<string, number>();
const key = (c: Pick<Candidate, 'provider' | 'model'>) => `${c.provider}:${c.model}`;

/** Quanto tempo deixar um candidato de lado, pelo tipo de erro */
export function markFailed(c: Candidate, err: unknown) {
  const msg = String(err instanceof Error ? err.message : err).toLowerCase();
  const minutes = /429|quota|limit/.test(msg) ? 15 : /tempo esgotado|timed? ?out/.test(msg) ? 5 : 2;
  cooldown.set(key(c), Date.now() + minutes * 60_000);
}

export function markOk(c: Candidate) {
  cooldown.delete(key(c));
}

const cooling = (c: Candidate) => (cooldown.get(key(c)) ?? 0) > Date.now();

let localCache: { at: number; models: LocalModel[] } | null = null;

async function localModels(endpoint: string): Promise<LocalModel[]> {
  if (localCache && Date.now() - localCache.at < 5 * 60_000) return localCache.models;
  const models = (await tryInvoke<LocalModel[]>('ollama_models', { endpoint })) ?? [];
  localCache = { at: Date.now(), models };
  return models;
}

function candidate(settings: Settings, id: ProviderId, model?: string): Candidate {
  const preset = presetOf(id);
  const m = model ?? providerConfig(settings, id).model;
  const local = preset.kind === 'ollama';
  return { provider: id, model: m, label: local ? `${preset.label} (${m})` : preset.label, local, timeout: local ? LOCAL_TIMEOUT : CLOUD_TIMEOUT };
}

/** Fila de tentativas para a próxima mensagem */
export async function buildChain(settings: Settings): Promise<Candidate[]> {
  const list: Candidate[] = [];
  const add = (c: Candidate) => {
    if (!list.some((x) => key(x) === key(c))) list.push(c);
  };

  if (providerReady(settings, settings.provider)) add(candidate(settings, settings.provider));
  for (const p of PROVIDERS) {
    if (p.group === 'free' && providerReady(settings, p.id)) add(candidate(settings, p.id));
  }

  // Modelos locais: o configurado e, se ele demorar, os menores que aceitam ferramentas
  const ollama = providerConfig(settings, 'ollama');
  const models = await localModels(ollama.endpoint);
  if (models.length) {
    const chat = models.filter((m) => !m.embedding);
    const configured = chat.find((m) => m.name === ollama.model);
    if (configured) add(candidate(settings, 'ollama', configured.name));
    chat
      .filter((m) => m.tools && m.name !== ollama.model)
      .sort((a, b) => a.size - b.size)
      .slice(0, LOCAL_ALTERNATIVES)
      .forEach((m) => add(candidate(settings, 'ollama', m.name)));
  }

  if (!list.length) list.push(candidate(settings, settings.provider));
  // Quem está de castigo vai para o fim (ainda tenta, se todo o resto falhar)
  return [...list.filter((c) => !cooling(c)), ...list.filter(cooling)];
}
