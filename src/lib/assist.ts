// Pergunta rápida à IA (sem ferramentas, sem histórico). No app, o cérebro escolhe o
// provedor mais rápido disponível; no navegador vai direto ao provedor escolhido.
import { streamChat } from '../api/aiService';
import { invoke, isTauri } from './tauri';
import type { Settings } from '../types';

export async function askAI(settings: Settings, prompt: string): Promise<string> {
  let text = '';
  if (isTauri()) text = await invoke<string>('brain_ask', { prompt });
  else await streamChat(settings, settings.provider, [{ role: 'user', text: prompt }], (c) => (text += c));
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
