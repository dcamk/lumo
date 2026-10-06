// Provedores de IA. Os gratuitos vêm do diretório awesome-free-llm-apis
// (github.com/open-free-llm-api/awesome-freellm-apis): quase todos falam o formato da
// OpenAI, então basta a URL base + chave. O botão "Listar" em Config → IA busca os
// modelos disponíveis no momento (os gratuitos mudam com frequência).
import type { ProviderConfig, ProviderId, Settings } from '../types';

export type ProviderKind = 'openai' | 'gemini' | 'claude' | 'ollama';

export interface ProviderPreset {
  id: ProviderId;
  label: string;
  kind: ProviderKind;
  group: 'free' | 'paid' | 'local';
  baseUrl?: string;
  defaultModel: string;
  keyUrl?: string;
  keyPlaceholder?: string;
  /** Funciona sem chave (com limite menor) */
  keyless?: boolean;
  /** URL base editável (OpenAI-compatível personalizado / Ollama) */
  editableBase?: boolean;
  /** Filtra a lista de modelos (ex.: só os gratuitos do OpenRouter) */
  modelFilter?: (id: string) => boolean;
  hint: string;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: 'groq',
    label: 'Groq',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    keyUrl: 'https://console.groq.com/keys',
    keyPlaceholder: 'gsk_…',
    hint: 'Grátis, sem cartão. O mais rápido.',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    kind: 'gemini',
    group: 'free',
    defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    keyPlaceholder: 'AIza…',
    hint: 'Camada grátis do Google AI Studio.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'nvidia/nemotron-3-super-120b-a12b:free',
    keyUrl: 'https://openrouter.ai/settings/keys',
    keyPlaceholder: 'sk-or-v1-…',
    modelFilter: (id) => id.endsWith(':free'),
    hint: 'Dezenas de modelos “:free” com uma chave só.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://api.cerebras.ai/v1',
    defaultModel: 'llama3.1-8b',
    keyUrl: 'https://cloud.cerebras.ai/',
    keyPlaceholder: 'csk-…',
    hint: 'Grátis, sem cartão. Muito rápido.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://api.mistral.ai/v1',
    defaultModel: 'mistral-small-latest',
    keyUrl: 'https://console.mistral.ai/api-keys',
    hint: 'Plano “Experiment” grátis.',
  },
  {
    id: 'nvidia',
    label: 'NVIDIA NIM',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    defaultModel: 'meta/llama-3.3-70b-instruct',
    keyUrl: 'https://build.nvidia.com/settings/api-keys',
    keyPlaceholder: 'nvapi-…',
    hint: 'Sem limite diário de tokens (40 req/min).',
  },
  {
    id: 'huggingface',
    label: 'Hugging Face',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://router.huggingface.co/v1',
    defaultModel: 'meta-llama/Llama-3.1-8B-Instruct',
    keyUrl: 'https://huggingface.co/settings/tokens',
    keyPlaceholder: 'hf_…',
    hint: 'Créditos mensais grátis.',
  },
  {
    id: 'llm7',
    label: 'LLM7',
    kind: 'openai',
    group: 'free',
    baseUrl: 'https://api.llm7.io/v1',
    defaultModel: 'fast',
    keyUrl: 'https://token.llm7.io',
    keyless: true,
    hint: 'Funciona sem chave (modelos “fast” e “default”); a chave grátis libera os outros.',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    kind: 'openai',
    group: 'paid',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-…',
    hint: 'Pago por uso.',
  },
  {
    id: 'claude',
    label: 'Claude',
    kind: 'claude',
    group: 'paid',
    defaultModel: 'claude-opus-5-5',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    keyPlaceholder: 'sk-ant-…',
    hint: 'Pago por uso.',
  },
  {
    id: 'custom',
    label: 'Personalizado',
    kind: 'openai',
    group: 'paid',
    baseUrl: '',
    defaultModel: '',
    editableBase: true,
    hint: 'Qualquer API compatível com OpenAI (URL base + chave).',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    kind: 'ollama',
    group: 'local',
    baseUrl: 'http://localhost:11434',
    defaultModel: 'llama3',
    editableBase: true,
    keyless: true,
    hint: 'Modelos locais, privados e ilimitados.',
  },
];

export const GROUP_LABEL: Record<ProviderPreset['group'], string> = {
  free: 'Gratuitos',
  paid: 'Pagos / próprios',
  local: 'No seu PC',
};

export const presetOf = (id: ProviderId) => PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

/** Configuração efetiva: o que o usuário salvou + padrões do provedor */
export function providerConfig(settings: Settings, id: ProviderId): Required<ProviderConfig> {
  const preset = presetOf(id);
  const saved = settings.providers[id] ?? {};
  return {
    apiKey: saved.apiKey ?? '',
    model: saved.model?.trim() || preset.defaultModel,
    endpoint: saved.endpoint?.trim() || preset.baseUrl || '',
  };
}

/** Pronto para uso: tem chave (ou não precisa) e, se for personalizado, uma URL */
export function providerReady(settings: Settings, id: ProviderId) {
  const preset = presetOf(id);
  const cfg = providerConfig(settings, id);
  if (preset.editableBase && !cfg.endpoint) return false;
  return preset.keyless || cfg.apiKey.trim().length > 0;
}
