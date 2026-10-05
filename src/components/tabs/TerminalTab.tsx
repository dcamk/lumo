import { Channel } from '@tauri-apps/api/core';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { getPalette, usePalette } from '../../theme/store';
import { xtermTheme } from '../../theme/xterm';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import { CornerDownLeft, Lightbulb, Play, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { askAI } from '../../lib/assist';
import { invoke, isTauri } from '../../lib/tauri';
import type { Settings } from '../../types';

interface Props {
  settings: Settings;
  /** A IA sugere correções quando um comando falha */
  assist: boolean;
  /** Um comando terminou: sucesso ou falha (para o Lumo reagir) */
  onCommandDone?: (ok: boolean) => void;
}

interface Suggestion {
  command: string;
  why: string;
  failed: string;
}

const MARK = /\x1b\]777;lumo;(\d+);(\d+);([A-Za-z0-9+/=]*)\x07/;
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|\x1b[()][A-Z0-9]|\r/g;

const b64ToBytes = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const b64ToText = (b64: string) => new TextDecoder().decode(b64ToBytes(b64));

/** Tira o primeiro bloco de código da resposta da IA: comando + explicação */
function parseSuggestion(reply: string, failed: string): Suggestion | null {
  const m = reply.match(/```(?:bash|sh|shell)?\n([\s\S]*?)```/);
  const command = m?.[1].trim().split('\n')[0]?.replace(/^\$\s*/, '').trim();
  if (!command) return null;
  const why = reply.replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim();
  return { command, why, failed };
}

/**
 * Terminal de verdade (bash num PTY, desenhado pelo xterm.js) no visual do painel.
 * A IA acompanha o que roda: se um comando falha, sugere a correção — e você decide
 * se insere no prompt, executa ou ignora.
 */
export function TerminalTab({ settings, assist, onCommandDone }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const palette = usePalette();
  // trocou de paleta com o terminal aberto: as cores acompanham
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(palette);
  }, [palette]);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const doneRef = useRef(onCommandDone);
  doneRef.current = onCommandDone;
  const [thinking, setThinking] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const helpRef = useRef(assist);
  helpRef.current = assist;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!host.current) return;
    if (!isTauri()) {
      setError('O terminal só funciona no app instalado (não no navegador).');
      return;
    }
    const term = new Terminal({
      fontFamily: '"JetBrains Mono", ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.15,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 5000,
      allowTransparency: true,
      theme: xtermTheme(getPalette()),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current);
    termRef.current = term;
    fit.fit();

    let alive = true;
    let replaying = true;
    const decoder = new TextDecoder();
    let pending = ''; // saída desde o último comando concluído
    const recent: string[] = []; // últimos comandos (contexto para a IA)
    let busy = false;

    const handleMark = (code: number, cmd: string) => {
      const output = pending.replace(ANSI, '').split('\n').slice(-40).join('\n').slice(-3000);
      pending = '';
      if (!cmd.trim()) return;
      recent.push(`${cmd} (saída ${code})`);
      if (recent.length > 5) recent.shift();
      const ok = code === 0;
      doneRef.current?.(ok);
      // 130/148 = você interrompeu (Ctrl+C / Ctrl+Z): não é erro
      if (ok || code === 130 || code === 148 || !helpRef.current || busy) return;
      busy = true;
      setSuggestion(null);
      setThinking(cmd);
      const prompt =
        'Você é o assistente do terminal do Lumo (Linux, Ubuntu/GNOME). Um comando falhou.\n' +
        `Comandos recentes: ${recent.slice(0, -1).join(' | ') || '(nenhum)'}\n` +
        `Comando: ${cmd}\nCódigo de saída: ${code}\nSaída final:\n${output || '(vazia)'}\n\n` +
        'Explique a causa em UMA frase curta e sugira UM comando que corrige ou resolve, em um bloco ```bash. ' +
        'Responda em português, sem rodeios. Se a correção exigir sudo, inclua sudo no comando.';
      askAI(settingsRef.current, prompt)
        .then((reply) => {
          if (alive) setSuggestion(parseSuggestion(reply, cmd) ?? { command: '', why: reply.slice(0, 400), failed: cmd });
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
          if (alive) setThinking(null);
        });
    };

    const feed = (b64: string) => {
      if (!b64) return;
      const bytes = b64ToBytes(b64);
      term.write(bytes);
      if (replaying) return;
      pending += decoder.decode(bytes, { stream: true });
      let m = MARK.exec(pending);
      while (m) {
        const before = pending.slice(0, m.index);
        const rest = pending.slice(m.index + m[0].length);
        pending = before;
        let cmd = '';
        try {
          cmd = b64ToText(m[3]);
        } catch {
          /* comando ilegível: segue sem ele */
        }
        handleMark(Number(m[1]), cmd);
        pending = rest;
        m = MARK.exec(pending);
      }
      if (pending.length > 20000) pending = pending.slice(-10000);
    };

    const channel = new Channel<string>();
    channel.onmessage = (b64) => {
      if (!alive) return;
      if (b64 === '') {
        // o shell terminou (exit): abre outro
        term.write('\r\n\x1b[2m[shell encerrado — abrindo outro]\x1b[0m\r\n');
        void invoke<string>('term_open', { cols: term.cols, rows: term.rows, onData: channel }).catch(() => undefined);
        return;
      }
      feed(b64);
    };

    void invoke<string>('term_open', { cols: term.cols, rows: term.rows, onData: channel })
      .then((snapshot) => {
        if (!alive) return;
        if (snapshot) term.write(b64ToBytes(snapshot));
        replaying = false;
        term.focus();
      })
      .catch((e) => setError(String(e)));

    const input = term.onData((d) => void invoke('term_write', { data: d }).catch(() => undefined));
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        void invoke('term_resize', { cols: term.cols, rows: term.rows }).catch(() => undefined);
      } catch {
        /* painel ainda sem tamanho */
      }
    });
    ro.observe(host.current);

    return () => {
      alive = false;
      input.dispose();
      ro.disconnect();
      termRef.current = null;
      term.dispose();
    };
  }, []);

  const send = (text: string) => {
    void invoke('term_write', { data: text }).catch(() => undefined);
    termRef.current?.focus();
  };

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2 pt-2">
      <div
        className="relative flex-1 min-h-0 rounded-xl border border-[color:var(--line-strong)] bg-[var(--surface-2)] overflow-hidden shadow-[inset_0_0_30px_color-mix(in_srgb,var(--accent)_8%,transparent)]"
        onClick={() => termRef.current?.focus()}
      >
        <div ref={host} className="absolute inset-0 px-2 py-1.5" />
        {error && <p className="absolute inset-0 grid place-items-center text-xs text-[var(--danger)] p-4 text-center">{error}</p>}
      </div>

      {(thinking || suggestion) && (
        <div className="shrink-0 rounded-xl border border-[color:var(--line-strong)] bg-[var(--surface)] p-2 text-[11px] text-[var(--text)]">
          {thinking && !suggestion && (
            <p className="flex items-center gap-1.5 text-slate-300">
              <Lightbulb className="w-3.5 h-3.5 text-[var(--warn)] animate-pulse" /> Olhando o erro de <code className="font-mono">{thinking}</code>…
            </p>
          )}
          {suggestion && (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-start gap-1.5">
                <Lightbulb className="w-3.5 h-3.5 text-[var(--warn)] shrink-0 mt-0.5" />
                <p className="flex-1 leading-snug">{suggestion.why || 'Tente este comando:'}</p>
                <button type="button" aria-label="Fechar sugestão" onClick={() => setSuggestion(null)} className="text-slate-500 hover:text-white">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
              {suggestion.command && (
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 truncate font-mono text-[11px] bg-[var(--surface-2)] rounded-md px-2 py-1 text-[var(--accent-3)]">{suggestion.command}</code>
                  <button
                    type="button"
                    onClick={() => {
                      send(suggestion.command);
                      setSuggestion(null);
                    }}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-[var(--surface-3)] hover:brightness-125 transition"
                    title="Escreve no prompt, sem executar"
                  >
                    <CornerDownLeft className="w-3 h-3" /> Inserir
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      send(`${suggestion.command}\r`);
                      setSuggestion(null);
                    }}
                    className="inline-flex items-center gap-1 h-6 px-2 rounded-full bg-[var(--accent)] text-[var(--on-accent)] hover:brightness-110 transition"
                    title="Executa agora"
                  >
                    <Play className="w-3 h-3" /> Executar
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Interruptor "IA acompanhando" para o cabeçalho */
export function AssistToggle({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={() => onChange(!on)}
      title={on ? 'A IA sugere correções quando um comando falha (clique para desligar)' : 'IA desligada neste terminal'}
      className={`inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] transition-colors ${
        on ? 'text-[var(--accent-3)] bg-[color-mix(in_srgb,var(--accent)_14%,transparent)] hover:bg-[color-mix(in_srgb,var(--accent)_24%,transparent)]' : 'text-slate-500 hover:text-white hover:bg-white/[0.08]'
      }`}
    >
      <Lightbulb className="w-3 h-3" /> {on ? 'IA acompanhando' : 'IA desligada'}
    </button>
  );
}
