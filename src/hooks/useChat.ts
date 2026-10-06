import { Channel } from '@tauri-apps/api/core';
import { useCallback, useRef, useState } from 'react';
import { streamChatFailover, type Turn } from '../api/aiService';
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
  | { type: 'notice'; text: string }
  /** Nenhum provedor respondeu no meio da tarefa: passos já concluídos */
  | { type: 'interrupted'; done: string[] };

/** Tarefa interrompida: o pedido e o que já foi feito, para retomar sem refazer */
interface Resume {
  request: string;
  done: string[];
}

/** Espera antes da retomada automática (o backend já deixou os provedores que falharam de castigo) */
const RESUME_DELAY_MS = 4000;

/** Pedido de retomada: o próximo provedor recebe o progresso e continua dali */
function resumeText(r: Resume, extra?: string) {
  const steps = r.done.map((l) => `- ${l}`).join('\n');
  return (
    `[Retomada] A tarefa anterior foi interrompida porque o provedor caiu. Pedido original:\n${r.request}\n\n` +
    `Já concluído (NÃO repita estes passos; continue de onde parou):\n${steps}` +
    (extra ? `\n\nNova mensagem do usuário: ${extra}` : '')
  );
}

const CANCELLED_RE = /cancelad/i;

const formatSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Texto que o modelo recebe: os arquivos com caminho real + o pedido */
function withFiles(text: string, files?: DroppedFile[]) {
  if (!files?.length) return text;
  const list = files.map((f) => `- ${f.path} (${f.is_dir ? 'pasta' : `${f.kind || 'arquivo'}, ${formatSize(f.size)}`})`).join('\n');
  return `Arquivos anexados (caminhos no disco — leia/inspecione antes de agir):\n${list}\n\nPedido: ${text}`;
}

/**
 * Conversa com o Lumo. No app, quem responde é o modelo principal do backend
 * (src-tauri/src/brain): ele tem memória, skills, plugins e terminal, e delega a
 * especialistas quando convém. Trocas de provedor, limites e erros internos ficam com
 * ele; os comandos que quer rodar aparecem aqui para aprovação.
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

  // Bolha da resposta que está chegando aos poucos (o `text` do fim do passo a substitui)
  const draft = useRef<{ id: string; text: string } | null>(null);
  // Progresso da tarefa em andamento (vem do backend se ninguém responder) e a retomada pendente
  const progress = useRef<string[]>([]);
  const pendingResume = useRef<Resume | null>(null);

  const onEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.type) {
        case 'text_delta': {
          if (!draft.current) {
            draft.current = { id: crypto.randomUUID(), text: '' };
            const id = draft.current.id;
            setItems((prev) => [...prev, { id, kind: 'assistant', text: '' }]);
          }
          draft.current.text += e.text;
          const { id, text } = draft.current;
          update(id, (m) => (m.kind === 'assistant' ? { ...m, text } : m));
          break;
        }
        case 'text': {
          const text = stripThinking(e.text);
          const d = draft.current;
          draft.current = null;
          if (d) {
            // fecha o rascunho: texto final, ou some se o passo terminou sem fala
            setItems((prev) => (text ? prev.map((m) => (m.id === d.id && m.kind === 'assistant' ? { ...m, text } : m)) : prev.filter((m) => m.id !== d.id)));
          } else if (text) setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: 'assistant', text }]);
          break;
        }
        case 'interrupted':
          progress.current = e.done;
          break;
        case 'notice':
          draft.current = null;
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

  /** Uma chamada ao modelo principal (backend) com o texto já pronto */
  const callBrain = async (requestText: string) => {
    const s = settingsRef.current;
    progress.current = [];
    const channel = new Channel<AgentEvent>();
    channel.onmessage = (e) => onEvent(e);
    await invoke('brain_send', {
      req: { text: requestText, auto_approve: s.agentAuto, persona: getPalette().persona },
      events: channel,
    });
  };

  const send = async (text: string, files?: DroppedFile[]) => {
    const s = settingsRef.current;
    const userItem: ChatItem = { id: crypto.randomUUID(), kind: 'user', text, files };
    const history = toTurns([...itemsRef.current, userItem]);
    setItems((prev) => [...prev, userItem]);
    draft.current = null;
    setLoading(true);
    sound.playPurr();

    let failed = false;
    try {
      if (isTauri()) {
        // O modelo principal (backend) cuida de tudo: memória, escolha de provedor,
        // especialistas e falhas. Aqui só chega o que ele decidiu mostrar.
        // Se a última tarefa caiu no meio, este pedido leva junto o que já foi feito.
        const request = withFiles(text, files);
        const resume = pendingResume.current;
        pendingResume.current = null;
        const full = resume ? resumeText(resume, request) : request;
        try {
          await callBrain(full);
        } catch (err) {
          const done = progress.current;
          if (!done.length || CANCELLED_RE.test(String(err))) throw err;
          // caiu no meio, com passos prontos: tenta uma vez de novo, em outro provedor, sem refazer
          const r: Resume = { request: resume ? resume.request : request, done: [...(resume?.done ?? []), ...done] };
          setItems((prev) => [...prev, { id: crypto.randomUUID(), kind: 'notice', text: `O provedor caiu no meio da tarefa — retomando em outro (${r.done.length} passos já feitos).` }]);
          await new Promise((ok) => setTimeout(ok, RESUME_DELAY_MS));
          try {
            await callBrain(resumeText(r));
          } catch (err2) {
            // guarda: a próxima mensagem continua de onde parou
            pendingResume.current = { request: r.request, done: [...r.done, ...progress.current] };
            throw err2;
          }
        }
      } else {
        // Navegador (npm run dev): só conversa, sem terminal nem equipe — com failover entre provedores
        let raw = '';
        const id = crypto.randomUUID();
        let got = false;
        await streamChatFailover(
          s,
          history,
          (chunk) => {
            raw += chunk;
            const shown = stripThinking(raw);
            if (!shown) return;
            if (!got) setItems((prev) => [...prev, { id, kind: 'assistant', text: shown }]);
            else update(id, (m) => (m.kind === 'assistant' ? { ...m, text: shown } : m));
            got = true;
          },
          (from, to) => console.info(`[Lumo] ${from} falhou; seguindo com ${to}`)
        );
      }
    } catch (err) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      note(pendingResume.current ? `${msg} Quando quiser, mande qualquer mensagem que eu continuo de onde parei.` : msg);
    }
    setLoading(false);
    onDone(!failed);
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
    pendingResume.current = null;
    progress.current = [];
    setItems([WELCOME]);
  }, []);

  return { items, loading, send, note, approve, stop, clear };
}
