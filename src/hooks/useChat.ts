import { Channel } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';
import { streamChat, type Turn } from '../api/aiService';
import { sound } from '../audio/SoundEngine';
import { invoke, isTauri } from '../lib/tauri';
import { getPalette } from '../theme/store';
import type { ChatItem, DroppedFile, Settings } from '../types';

/** Alguns modelos gratuitos mandam o raciocínio junto: <think>…</think> (às vezes sem fechar) */
const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();

/** Linhas de saída guardadas por comando (o resto rola para fora) */
const OUTPUT_LINES = 300;
/** Itens anteriores que vão de contexto para o modelo */
const HISTORY_ITEMS = 30;
/** Linhas da saída de cada comando que ficam no contexto das próximas mensagens */
const CONTEXT_OUTPUT_LINES = 15;

/**
 * Histórico para o modelo: falas + o que foi executado (comando, código e o fim da
 * saída). Assim a IA lembra do que já fez nas mensagens seguintes, em qualquer
 * provedor (as ferramentas de cada formato não se misturam).
 */
function toTurns(items: ChatItem[]): Turn[] {
  const turns: Turn[] = [];
  const push = (role: Turn['role'], text: string) => {
    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += `\n\n${text}`;
    else turns.push({ role, text });
  };
  for (const m of items.slice(-HISTORY_ITEMS)) {
    if (m.id === WELCOME.id) continue;
    if (m.kind === 'user') push('user', withFiles(m.text, m.files));
    else if (m.kind === 'assistant') push('assistant', m.text);
    else if (m.kind === 'command') {
      const out = m.output.slice(-CONTEXT_OUTPUT_LINES).join('\n');
      const status = m.status === 'refused' ? 'recusado pelo usuário' : m.code === 0 ? 'ok' : `código ${m.code ?? '?'}`;
      push('assistant', `[executei] $ ${m.command} → ${status}${out ? `\n${out}` : ''}`);
    } else if (m.kind === 'write') push('assistant', `[gravei] ${m.path} → ${m.status}`);
  }
  // o modelo precisa terminar com a fala do usuário
  while (turns.length && turns[0].role === 'assistant') turns.shift();
  return turns;
}

const WELCOME: ChatItem = {
  id: 'welcome',
  kind: 'assistant',
  text: 'Oi! Me peça uma tarefa — “instale o VLC”, “quanto espaço tenho livre?” — ou arraste um arquivo até mim.',
};

/** Eventos do agente (src-tauri/src/agent.rs) */
type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'command'; id: string; command: string; reason: string; needs_approval: boolean }
  | { type: 'output'; id: string; line: string }
  | { type: 'command_done'; id: string; code: number | null; approved: boolean }
  | { type: 'write'; id: string; path: string; preview: string; needs_approval: boolean }
  | { type: 'write_done'; id: string; approved: boolean; error: string | null }
  | { type: 'read'; path: string }
  | { type: 'notice'; text: string };

const formatSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Texto que o modelo recebe: os arquivos com caminho real + o pedido */
function withFiles(text: string, files?: DroppedFile[]) {
  if (!files?.length) return text;
  const list = files.map((f) => `- ${f.path} (${f.is_dir ? 'pasta' : `${f.kind || 'arquivo'}, ${formatSize(f.size)}`})`).join('\n');
  return `Arquivos anexados (caminhos no disco — leia/inspecione antes de agir):\n${list}\n\nPedido: ${text}`;
}

/**
 * Conversa com a IA. No app, quem responde é o "cérebro" (src-tauri/src/brain): o modelo
 * principal (o provedor escolhido em Config → IA) com acesso ao terminal, memória e
 * especialistas. Os comandos que ele quer rodar aparecem no chat para aprovação.
 * Se o provedor falhar, o cérebro troca sozinho para outro gratuito configurado.
 */
export function useChat(settings: Settings, onDone: (ok: boolean) => void) {
  const [items, setItems] = useState<ChatItem[]>([WELCOME]);
  const [loading, setLoading] = useState(false);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const update = useCallback((id: string, fn: (item: ChatItem) => ChatItem) => {
    setItems((prev) => prev.map((m) => (m.id === id ? fn(m) : m)));
  }, []);

  const note = useCallback(
    (text: string) => setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: 'assistant', text }]),
    []
  );

  // Resposta chegando aos poucos: um balão "rascunho" que o texto final substitui
  const draft = useRef<{ id: string; text: string } | null>(null);
  const onEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.type) {
        case 'text_delta': {
          if (!draft.current) {
            const id = crypto.randomUUID();
            draft.current = { id, text: e.text };
            setItems((prev) => [...prev, { id, kind: 'assistant', text: e.text }]);
          } else {
            const d = draft.current;
            d.text += e.text;
            const text = d.text;
            update(d.id, (m) => (m.kind === 'assistant' ? { ...m, text } : m));
          }
          break;
        }
        case 'text': {
          // Texto final do passo (substitui o rascunho); vazio = a tentativa falhou, apaga o rascunho
          const text = stripThinking(e.text);
          const d = draft.current;
          draft.current = null;
          if (d) {
            if (text) update(d.id, (m) => (m.kind === 'assistant' ? { ...m, text } : m));
            else setItems((prev) => prev.filter((m) => m.id !== d.id));
          } else if (text) {
            setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: 'assistant', text }]);
          }
          break;
        }
        case 'notice':
          setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: 'notice', text: e.text }]);
          break;
        case 'read':
          setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: 'notice', text: `Lendo ${e.path}` }]);
          break;
        case 'command':
          if (e.needs_approval) sound.playChirp();
          setItems((prev) => [
            ...prev,
            { id: e.id, kind: 'command', command: e.command, reason: e.reason, status: e.needs_approval ? 'pending' : 'running', output: [] },
          ]);
          break;
        case 'output':
          update(e.id, (m) =>
            m.kind === 'command' ? { ...m, status: 'running', output: [...m.output, e.line].slice(-OUTPUT_LINES) } : m
          );
          break;
        case 'command_done':
          update(e.id, (m) => (m.kind === 'command' ? { ...m, status: e.approved ? 'done' : 'refused', code: e.code } : m));
          break;
        case 'write':
          setItems((prev) => [
            ...prev,
            { id: e.id, kind: 'write', path: e.path, preview: e.preview, status: e.needs_approval ? 'pending' : 'done' },
          ]);
          break;
        case 'write_done':
          update(e.id, (m) => (m.kind === 'write' ? { ...m, status: e.approved ? 'done' : 'refused', error: e.error } : m));
          break;
      }
    },
    [update]
  );

  const sending = useRef(false);
  const send = async (text: string, files?: DroppedFile[]) => {
    // Uma tarefa por vez: o agente tem um único "Parar" e uma fila de aprovações
    if (sending.current || !text.trim()) return;
    sending.current = true;
    const s = settingsRef.current;
    const userItem: ChatItem = { id: crypto.randomUUID(), kind: 'user', text, files };
    const history = toTurns([...itemsRef.current, userItem]);
    setItems((prev) => [...prev, userItem]);
    setLoading(true);
    sound.playPurr();
    draft.current = null;

    let error: unknown = null;
    try {
      if (isTauri()) {
        // O cérebro guarda a conversa (sobrevive a reinícios); só vai a fala nova
        const channel = new Channel<AgentEvent>();
        channel.onmessage = onEvent;
        await invoke('brain_send', {
          req: { text: withFiles(text, files), auto_approve: s.agentAuto, persona: getPalette().persona },
          events: channel,
        });
      } else {
        // Navegador (npm run dev): só conversa, sem terminal
        let raw = '';
        const id = crypto.randomUUID();
        let got = false;
        await streamChat(s, s.provider, history, (chunk) => {
          raw += chunk;
          const shown = stripThinking(raw);
          if (!shown) return;
          if (!got) setItems((prev) => [...prev, { id, kind: 'assistant', text: shown }]);
          else update(id, (m) => (m.kind === 'assistant' ? { ...m, text: shown } : m));
          got = true;
        });
      }
    } catch (err) {
      error = err;
    }
    // Rascunho que ficou vazio (a tentativa falhou no meio): some da conversa
    const d = draft.current as { id: string; text: string } | null;
    draft.current = null;
    if (d && !d.text.trim()) setItems((prev) => prev.filter((m) => m.id !== d.id));
    if (error) note(error instanceof Error ? error.message : String(error));
    sending.current = false;
    setLoading(false);
    onDone(!error);
  };

  /** Resposta do usuário a um comando/gravação pendente */
  const approve = useCallback(
    (id: string, ok: boolean) => {
      update(id, (m) => {
        if (m.kind === 'command') return { ...m, status: ok ? 'running' : 'refused' };
        if (m.kind === 'write') return { ...m, status: ok ? 'done' : 'refused' };
        return m;
      });
      void invoke('agent_approve', { id, approved: ok }).catch(() => {});
    },
    [update]
  );

  const stop = useCallback(() => void invoke('agent_cancel').catch(() => {}), []);

  /** Nova conversa: para o que estiver rodando e limpa o contexto */
  const clear = useCallback(() => {
    void invoke('agent_cancel').catch(() => {});
    void invoke('brain_reset').catch(() => {});
    draft.current = null;
    setItems([WELCOME]);
  }, []);

  return { items, loading, send, note, approve, stop, clear };
}
