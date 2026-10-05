import { DEFAULT_PALETTE, type PaletteId, type VoiceStyle } from '../theme/palettes';

/** compact = pílula · quick = painel · drop = "solte o arquivo aqui" */
export type WindowMode = 'compact' | 'quick' | 'drop';

export type PanelTab = 'tasks' | 'focus' | 'chat' | 'mail' | 'linux' | 'terminal' | 'style' | 'settings';

export interface Task {
  id: string;
  text: string;
  completed: boolean;
  /** Lembrete (ms desde 1970), criado com "… em 20m" ou "… às 15:30" */
  remindAt?: number;
  /** O lembrete já tocou */
  reminded?: boolean;
}

/** Arquivo arrastado para o Lumo (caminho real no disco) */
export interface DroppedFile {
  path: string;
  name: string;
  size: number;
  /** tipo MIME (comando `file`) */
  kind: string;
  is_dir: boolean;
}

/** Itens da conversa: falas, comandos que a IA quer rodar, arquivos que quer gravar */
export type ChatItem =
  | { id: string; kind: 'user'; text: string; files?: DroppedFile[] }
  | { id: string; kind: 'assistant'; text: string; via?: string }
  | {
      id: string;
      kind: 'command';
      command: string;
      reason: string;
      /** pending = esperando o usuário aprovar */
      status: 'pending' | 'running' | 'done' | 'refused';
      code?: number | null;
      output: string[];
    }
  | { id: string; kind: 'write'; path: string; preview: string; status: 'pending' | 'done' | 'refused'; error?: string | null }
  | { id: string; kind: 'notice'; text: string };

/** 'lumo' = olhos seguem o mouse só sobre o Lumo; 'screen' = na tela inteira */
export type CursorMode = 'lumo' | 'screen';

/** Ids em src/lib/providers.ts */
export type ProviderId =
  | 'groq'
  | 'gemini'
  | 'openrouter'
  | 'cerebras'
  | 'mistral'
  | 'nvidia'
  | 'huggingface'
  | 'llm7'
  | 'openai'
  | 'claude'
  | 'custom'
  | 'ollama';

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  /** URL base (personalizado / Ollama) */
  endpoint?: string;
}

/** Ação rápida da aba Linux: um comando do shell */
export interface QuickAction {
  id: string;
  label: string;
  command: string;
  /** output = mostra a saída · terminal = abre num terminal (sudo, interativo) · launch = abre um programa */
  mode: 'output' | 'terminal' | 'launch';
}

export interface Settings {
  volume: number; // 0–1
  muted: boolean;
  lumoScale: number; // 0.8–1.6 — personagem + janela (lib/layout.ts)
  cursorMode: CursorMode;
  alwaysOnTop: boolean;
  provider: ProviderId;
  providers: Partial<Record<ProviderId, ProviderConfig>>;
  /** Se o provedor falhar (limite, fora do ar), tenta outro gratuito configurado */
  aiFallback: boolean;
  /** Notificação do sistema para e-mail novo (além do aviso na pílula) */
  mailNotify: boolean;
  /** Intervalo da checagem do Gmail, em minutos */
  mailInterval: number;
  /** Aviso na pílula quando RAM/disco/temperatura/bateria passam do limite */
  systemAlerts: boolean;
  /** Ações criadas pelo usuário (as prontas ficam em LinuxTab) */
  quickActions: QuickAction[];
  /** IA executa comandos sem pedir aprovação (os perigosos e com sudo sempre pedem) */
  agentAuto: boolean;
  /** Saída de som: 'system' = PipeWire/PulseAudio (recomendado) · 'webkit' = Web Audio */
  audioOutput: 'system' | 'webkit';
  /** Quanto o painel foi esticado pelo canto (px) */
  panelExtra: { w: number; h: number };
  /** Paleta = cores + personalidade (theme/palettes.ts) */
  palette: PaletteId;
  /** Voz dos sons: 'auto' segue a paleta */
  voice: 'auto' | VoiceStyle;
  /** Visual do corpo: 'classico' (desenho limpo) ou 'realista' (vidro polido com reflexos) */
  look: 'classico' | 'realista';
}

export const DEFAULT_SETTINGS: Settings = {
  volume: 0.55,
  muted: false,
  lumoScale: 1,
  cursorMode: 'screen',
  alwaysOnTop: true,
  provider: 'llm7', // funciona sem chave; troque em Config → IA
  providers: {},
  aiFallback: true,
  mailNotify: true,
  mailInterval: 2,
  systemAlerts: true,
  quickActions: [],
  agentAuto: false,
  audioOutput: 'system',
  panelExtra: { w: 0, h: 0 },
  palette: DEFAULT_PALETTE,
  voice: 'auto',
  look: 'classico',
};
