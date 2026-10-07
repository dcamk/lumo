// Chat do celular com o cérebro do PC (mesma conversa e memória do Lumo do PC).
// Comandos e gravações que a IA quiser fazer no PC aparecem aqui para aprovar.
import { useCallback, useRef, useState } from 'react';
import type { ChatItem } from '../../../src/types';
import { getPalette } from '../../../src/theme/store';
import { haptic, type AgentEvent, type Bridge } from '../lib/bridge';
import { uid } from '../lib/uid';

const stripThinking = (text: string) => text.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
const OUTPUT_LINES = 200;
const STORE = 'lumo.mobile.chat';

const WELCOME: ChatItem = {
  id: 'welcome',
  kind: 'assistant',
  text: 'Oi! Estou usando a IA do seu PC. Peça o que quiser: “quanto espaço livre tenho no PC?”, “resuma este texto”, “organize meus Downloads”.',
};

function load(): ChatItem[] {
  try {
    const items = JSON.parse(localStorage.getItem(STORE) ?? 'null') as ChatItem[] | null;
    if (Array.isArray(items) && items.length) {
      // Pedidos de aprovação antigos não valem mais (a conversa no PC já terminou)
      return items.map((m) => ((m.kind === 'command' || m.kind === 'write') && m.status === 'pending' ? { ...m, status: 'refused' } : m));
    }
  } catch {
    /* sem histórico */
  }
  return [WELCOME];
}

function save(items: ChatItem[]) {
  try {
    localStorage.setItem(STORE, JSON.stringify(items.slice(-80)));
  } catch {
    /* sem espaço: tudo bem */
  }
}

export type ChatPhase = 'idle' | 'thinking' | 'talking';

export function useRemoteChat(bridge: Bridge | null, onReply?: (ok: boolean) => void) {
  const [items, setItemsRaw] = useState<ChatItem[]>(load);
  const [phase, setPhase] = useState<ChatPhase>('idle');
  const abort = useRef<AbortController | null>(null);
  const draft = useRef<{ id: string; text: string } | null>(null);
  const talkTimer = useRef(0);

  const setItems = useCallback((fn: (prev: ChatItem[]) => ChatItem[]) => {
    setItemsRaw((prev) => {
      const next = fn(prev);
      save(next);
      return next;
    });
  }, []);

  const update = useCallback((id: string, fn: (m: ChatItem) => ChatItem) => setItems((prev) => prev.map((m) => (m.id === id ? fn(m) : m))), [setItems]);

  const talking = () => {
    setPhase('talking');
    clearTimeout(talkTimer.current);
    talkTimer.current = window.setTimeout(() => setPhase((p) => (p === 'talking' ? 'thinking' : p)), 700);
  };

  const onEvent = useCallback(
    (e: AgentEvent) => {
      switch (e.type) {
        case 'text_delta': {
          if (!draft.current) {
            draft.current = { id: uid(), text: '' };
            const id = draft.current.id;
            setItems((prev) => [...prev, { id, kind: 'assistant', text: '' }]);
          }
          draft.current.text += e.text;
          const { id, text } = draft.current;
          const shown = stripThinking(text);
          update(id, (m) => (m.kind === 'assistant' ? { ...m, text: shown } : m));
          talking();
          break;
        }
        case 'text': {
          const text = stripThinking(e.text);
          const d = draft.current;
          draft.current = null;
          if (d) setItems((prev) => (text ? prev.map((m) => (m.id === d.id && m.kind === 'assistant' ? { ...m, text } : m)) : prev.filter((m) => m.id !== d.id)));
          else if (text) setItems((prev) => [...prev, { id: uid(), kind: 'assistant', text }]);
          if (text) talking();
          break;
        }
        case 'notice':
          draft.current = null;
          setItems((prev) => [...prev, { id: uid(), kind: 'notice', text: e.text }]);
          break;
        case 'read':
          setItems((prev) => [...prev, { id: uid(), kind: 'notice', text: `Lendo ${e.path}` }]);
          break;
        case 'command':
          if (e.needs_approval) haptic(30);
          setItems((prev) => [...prev, { id: e.id, kind: 'command', command: e.command, reason: e.reason, status: e.needs_approval ? 'pending' : 'running', output: [] }]);
          break;
        case 'output':
          update(e.id, (m) => (m.kind === 'command' ? { ...m, status: 'running', output: [...m.output, e.line].slice(-OUTPUT_LINES) } : m));
          break;
        case 'command_done':
          update(e.id, (m) => (m.kind === 'command' ? { ...m, status: e.approved ? 'done' : 'refused', code: e.code } : m));
          break;
        case 'write':
          if (e.needs_approval) haptic(30);
          setItems((prev) => [...prev, { id: e.id, kind: 'write', path: e.path, preview: e.preview, status: e.needs_approval ? 'pending' : 'done' }]);
          break;
        case 'write_done':
          update(e.id, (m) => (m.kind === 'write' ? { ...m, status: e.approved ? 'done' : 'refused', error: e.error } : m));
          break;
        case 'interrupted':
          break;
      }
    },
    [setItems, update]
  );

  const send = useCallback(
    async (text: string) => {
      const t = text.trim();
      if (!t || !bridge || phase !== 'idle') return;
      setItems((prev) => [...prev, { id: uid(), kind: 'user', text: t }]);
      draft.current = null;
      setPhase('thinking');
      haptic(8);
      const ctl = new AbortController();
      abort.current = ctl;
      let ok = true;
      try {
        await bridge.chat(t, getPalette().persona, onEvent, ctl.signal);
      } catch (err) {
        ok = false;
        setItems((prev) => [...prev, { id: uid(), kind: 'notice', text: err instanceof Error ? err.message : String(err) }]);
      }
      clearTimeout(talkTimer.current);
      abort.current = null;
      draft.current = null;
      setPhase('idle');
      onReply?.(ok);
    },
    [bridge, phase, onEvent, setItems, onReply]
  );

  const approve = useCallback(
    (id: string, ok: boolean) => {
      haptic(12);
      update(id, (m) => {
        if (m.kind === 'command') return { ...m, status: ok ? 'running' : 'refused' };
        if (m.kind === 'write') return { ...m, status: ok ? 'done' : 'refused' };
        return m;
      });
      void bridge?.post('/api/approve', { id, approved: ok }).catch(() => {});
    },
    [bridge, update]
  );

  const stop = useCallback(() => {
    void bridge?.post('/api/cancel').catch(() => {});
  }, [bridge]);

  const clear = useCallback(() => {
    abort.current?.abort();
    setItems(() => [WELCOME]);
  }, [setItems]);

  return { items, phase, send, approve, stop, clear };
}
