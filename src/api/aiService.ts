import { Channel } from '@tauri-apps/api/core';
import { presetOf, providerConfig } from '../lib/providers';
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

/** Vale a pena tentar outro provedor? (limite, servidor fora, sem conexão, sem chave) */
export function isRetryable(err: unknown) {
  const msg = String(err instanceof Error ? err.message : err);
  return /HTTP (4\d\d|5\d\d)|conectar|connect|timed? ?out|tempo esgotado|quota|não configurada|not found|unavailable/i.test(msg);
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
