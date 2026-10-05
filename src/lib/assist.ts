// Pergunta rápida à IA (sem ferramentas, sem histórico) pela mesma fila de provedores do chat:
// o configurado, os gratuitos disponíveis e, por fim, os modelos locais.
import { isRetryable, streamChat } from '../api/aiService';
import { buildChain, markFailed, markOk } from './router';
import type { Settings } from '../types';

export async function askAI(settings: Settings, prompt: string): Promise<string> {
  const chain = await buildChain(settings);
  let lastError: unknown = null;
  for (const cand of chain) {
    // O candidato pode trocar o modelo (ex.: um modelo local menor)
    const s: Settings = {
      ...settings,
      providers: { ...settings.providers, [cand.provider]: { ...settings.providers[cand.provider], model: cand.model } },
    };
    let text = '';
    try {
      await Promise.race([
        streamChat(s, cand.provider, [{ role: 'user', text: prompt }], (c) => (text += c)),
        new Promise((_, rej) => setTimeout(() => rej(new Error('tempo esgotado')), cand.timeout * 1000)),
      ]);
      markOk(cand);
      return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
    } catch (err) {
      lastError = err;
      markFailed(cand, err);
      if (text || !isRetryable(err)) break;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'sem resposta'));
}
