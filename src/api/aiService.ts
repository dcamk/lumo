import { Channel } from '@tauri-apps/api/core';
import { PROVIDERS, presetOf, providerConfig, providerReady } from '../lib/providers';
import { invoke, isTauri } from '../lib/tauri';
import { getPalette } from '../theme/store';
import type { ProviderId, Settings } from '../types';

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

const SYSTEM_PROMPT =
  'Você é o Lumo, assistente pessoal de produtividade para Linux. Seja prestativo, calmo e conciso. ' +
  'Responda em português, focado em ajudar o usuário a manter o fluxo de trabalho. ' +
  'Quando sugerir comandos de terminal, use blocos de código e explique o que fazem.';

/** Prompt base + a personalidade da paleta ativa (tom das respostas) */
export const systemPrompt = () => `${SYSTEM_PROMPT} Personalidade (só o tom): ${getPalette().persona}`;

/**
 * Envia a conversa para um provedor. `onChunk` recebe cada pedaço do texto assim que
 * chega (streaming). No app nativo a chamada sai pelo Rust (sem CORS); no navegador
 * (npm run dev puro) usa o servidor Express, sem streaming.
 */
export async function streamChat(
  settings: Settings,
  provider: ProviderId,
  history: Turn[],
  onChunk: (text: string) => void
): Promise<void> {
  const preset = presetOf(provider);
  const cfg = providerConfig(settings, provider);
  const messages = history.map((m) => ({ role: m.role, content: m.text }));

  if (isTauri()) {
    const channel = new Channel<string>();
    channel.onmessage = onChunk;
    await invoke('dispatch_ai_stream', {
      req: {
        provider,
        messages,
        system: systemPrompt(),
        model: cfg.model,
        endpoint: cfg.endpoint || undefined,
        api_key: cfg.apiKey,
      },
      onChunk: channel,
    });
    return;
  }

  const res = await fetch('/api/ai/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider: preset.kind === 'openai' ? 'openai-compatible' : provider,
      messages,
      systemPrompt: systemPrompt(),
      customConfig: cfg,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} — ${data.error || 'erro'}`);
  onChunk(data.reply || 'Sem resposta.');
}

/** Tipo de falha de um provedor (mesma classificação do backend, src-tauri/src/brain/llm.rs) */
export type FailKind = 'limit' | 'timeout' | 'server' | 'auth' | 'unsupported' | 'other';

export function classifyError(err: unknown): FailKind {
  const e = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (e.includes('ferramentas não suportadas')) return 'unsupported';
  if (/http 429\b/.test(e) || e.includes('quota') || e.includes('rate limit') || e.includes('rate_limit')) return 'limit';
  if (e.includes('tempo esgotado') || e.includes('timed out') || e.includes('timeout') || e.includes('aborterror')) return 'timeout';
  if (/http 5\d\d\b/.test(e) || e.includes('overloaded') || e.includes('failed to fetch') || e.includes('networkerror') || e.includes('não consegui conectar')) return 'server';
  if (/http 40[123]\b/.test(e) || e.includes('api key') || e.includes('unauthorized') || e.includes('insufficient balance')) return 'auth';
  return 'other';
}

/** Falhas passageiras (429, 5xx, rede, tempo esgotado): troca de provedor na hora */
export const isRecoverable = (kind: FailKind) => kind === 'limit' || kind === 'timeout' || kind === 'server' || kind === 'unsupported';

/** Sem nenhum pedaço de resposta neste tempo, o provedor é considerado lento e trocado */
const FIRST_CHUNK_MS = 30_000;

/**
 * `streamChat` com failover: tenta o provedor escolhido e, numa falha passageira, passa
 * ao próximo configurado sem repetir o lento. Se já tinha chegado texto, o próximo
 * recebe o trecho pronto para continuar dali (não recomeça a resposta).
 */
export async function streamChatFailover(
  settings: Settings,
  history: Turn[],
  onChunk: (text: string) => void,
  onSwitch?: (from: ProviderId, to: ProviderId, kind: FailKind) => void
): Promise<ProviderId> {
  const order = [settings.provider, ...PROVIDERS.map((p) => p.id).filter((id) => id !== settings.provider && providerReady(settings, id))];
  let partial = '';
  let lastErr: unknown = new Error('nenhum provedor configurado');
  for (let i = 0; i < order.length; i++) {
    const provider = order[i];
    const turns: Turn[] = partial
      ? [...history, { role: 'assistant', text: partial }, { role: 'user', text: 'Continue exatamente de onde parou, sem repetir o que já escreveu.' }]
      : history;
    let got = false;
    let live = true; // tentativa abandonada por lentidão não escreve mais nada
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        streamChat(settings, provider, turns, (chunk) => {
          if (!live) return;
          got = true;
          partial += chunk;
          onChunk(chunk);
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => !got && reject(new Error(`tempo esgotado: ${presetOf(provider).label} não respondeu`)), FIRST_CHUNK_MS);
        }),
      ]);
      clearTimeout(timer);
      return provider;
    } catch (err) {
      clearTimeout(timer);
      live = false;
      lastErr = err;
      const kind = classifyError(err);
      const next = order[i + 1];
      if (!next || (!isRecoverable(kind) && kind !== 'auth')) break;
      onSwitch?.(provider, next, kind);
    }
  }
  throw lastErr;
}

/** Modelos de um provedor compatível com OpenAI */
export async function listModels(settings: Settings, provider: ProviderId) {
  const preset = presetOf(provider);
  const cfg = providerConfig(settings, provider);
  // O Ollama também responde no formato da OpenAI em /v1
  const endpoint = preset.kind === 'ollama' ? `${cfg.endpoint.replace(/\/+$/, '')}/v1` : cfg.endpoint;
  const ids = await invoke<string[]>('list_models', { endpoint, apiKey: cfg.apiKey || null });
  return preset.modelFilter ? ids.filter(preset.modelFilter) : ids;
}
