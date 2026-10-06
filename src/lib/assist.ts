// Pergunta rápida à IA (sem histórico): o backend escolhe o melhor modelo disponível.
import { invoke } from './tauri';
import type { Settings } from '../types';

export async function askAI(_settings: Settings, prompt: string): Promise<string> {
  return (await invoke<string>('brain_ask', { prompt })).trim();
}
