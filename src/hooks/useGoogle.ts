import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke, tryInvoke } from '../lib/tauri';

export interface GoogleStatus {
  configured: boolean;
  /** De onde veio o Client ID: 'app' (Config → Contas) | 'env' | 'build' */
  source: 'app' | 'env' | 'build' | null;
  connected: boolean;
  email: string | null;
}

export interface MailSummary {
  id: string;
  thread_id: string;
  from: string;
  subject: string;
  snippet: string;
  /** ms desde 1970 */
  date: number;
}

interface Inbox {
  total: number;
  messages: MailSummary[];
}

export interface GoogleControls {
  status: GoogleStatus | null;
  busy: boolean;
  error: string;
  /** Não lidos na caixa de entrada */
  unread: number;
  messages: MailSummary[];
  lastCheck: number | null;
  checking: boolean;
  connect: () => void;
  disconnect: () => void;
  configure: (clientId: string, clientSecret: string) => Promise<boolean>;
  refresh: () => void;
}

declare global {
  interface Window {
    /** Atalhos de teste no console (ex.: lumoDebug.fakeEmail()) */
    lumoDebug?: { fakeEmail: (from?: string, subject?: string) => void; drop?: (paths: string[]) => void; dragOver?: (x: number, y: number) => void };
  }
}

/** Link do e-mail no Gmail web */
export const gmailLink = (m?: Pick<MailSummary, 'thread_id' | 'id'>) =>
  m ? `https://mail.google.com/mail/u/0/#inbox/${m.thread_id || m.id}` : 'https://mail.google.com/mail/u/0/#inbox';

/**
 * Conta Google: status, configuração do cliente OAuth, conectar/desconectar e checagem
 * periódica dos não lidos. `onNewMail` só recebe e-mails que chegaram depois da
 * primeira checagem (o que já estava lá não vira aviso).
 */
export function useGoogle(intervalMin: number, onNewMail: (mails: MailSummary[]) => void): GoogleControls {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [inbox, setInbox] = useState<Inbox>({ total: 0, messages: [] });
  const [lastCheck, setLastCheck] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const seen = useRef<Set<string> | null>(null);
  const onNewMailRef = useRef(onNewMail);
  onNewMailRef.current = onNewMail;

  useEffect(() => {
    void tryInvoke<GoogleStatus>('google_status').then(setStatus);
  }, []);

  const run = useCallback(async (fn: () => Promise<GoogleStatus>) => {
    setBusy(true);
    setError('');
    try {
      setStatus(await fn());
      return true;
    } catch (err) {
      setError(String(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  const connect = useCallback(() => void run(() => invoke<GoogleStatus>('google_connect')), [run]);

  const disconnect = useCallback(() => {
    seen.current = null;
    setInbox({ total: 0, messages: [] });
    setLastCheck(null);
    void run(() => invoke<GoogleStatus>('google_disconnect'));
  }, [run]);

  const configure = useCallback(
    (clientId: string, clientSecret: string) =>
      run(() => invoke<GoogleStatus>('google_set_client', { clientId, clientSecret })),
    [run]
  );

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const next = await invoke<Inbox>('gmail_unread');
      setInbox(next);
      setLastCheck(Date.now());
      setError('');
      if (seen.current) {
        const fresh = next.messages.filter((m) => !seen.current!.has(m.id));
        if (fresh.length) onNewMailRef.current(fresh);
        fresh.forEach((m) => seen.current!.add(m.id));
      } else {
        seen.current = new Set(next.messages.map((m) => m.id));
      }
    } catch (err) {
      const msg = String(err);
      // Token revogado no Google: mostra como desconectado
      if (/invalid_grant|não conectada/i.test(msg)) void tryInvoke<GoogleStatus>('google_status').then(setStatus);
      setError(msg);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    if (!status?.connected) return;
    void check();
    const id = window.setInterval(check, Math.max(1, intervalMin) * 60_000);
    return () => window.clearInterval(id);
  }, [status?.connected, intervalMin, check]);

  // Teste sem conta: lumoDebug.fakeEmail('Ana', 'Reunião às 15h')
  useEffect(() => {
    window.lumoDebug = {
      fakeEmail: (from = 'Ana Souza', subject = 'Teste de aviso do Lumo') => {
        const mail: MailSummary = {
          id: crypto.randomUUID(),
          thread_id: '',
          from,
          subject,
          snippet: 'Este é um e-mail de teste gerado pelo console.',
          date: Date.now(),
        };
        setInbox((prev) => ({ total: prev.total + 1, messages: [mail, ...prev.messages] }));
        onNewMailRef.current([mail]);
      },
    };
    return () => {
      delete window.lumoDebug;
    };
  }, []);

  return {
    status,
    busy,
    error,
    unread: inbox.total,
    messages: inbox.messages,
    lastCheck,
    checking,
    connect,
    disconnect,
    configure,
    refresh: () => void check(),
  };
}
