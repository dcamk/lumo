import { FileText, Folder, Send, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { CharacterCanvas, type CharacterEmotion } from '../character/CharacterCanvas';
import { sound } from '../audio/SoundEngine';
import { gulp, reducedMotion } from '../lib/motion';
import { Glow } from './Glow';
import type { DroppedFile } from '../types';

interface Props {
  /** null = esperando o arquivo cair */
  files: DroppedFile[] | null;
  /** Onde está o arquivo sendo arrastado (coordenadas da página) */
  pointer: { x: number; y: number } | null;
  emotion: CharacterEmotion;
  globalCursor: boolean;
  onGlobalCursorBroken: () => void;
  onSubmit: (task: string) => void;
  onCancel: () => void;
}

/** Sugestões de acordo com o tipo do arquivo */
function suggestions(files: DroppedFile[]): string[] {
  const f = files[0];
  const name = f.name.toLowerCase();
  if (files.length > 1) return ['Organize em pastas por tipo', 'Compacte num .zip', 'Diga o que são'];
  if (f.is_dir) return ['Quanto espaço ocupa?', 'Compacte num .zip', 'Organize por tipo'];
  if (name.endsWith('.deb')) return ['Instale este pacote', 'O que este pacote instala?'];
  if (name.endsWith('.appimage')) return ['Instale e crie um atalho no menu', 'Torne executável e abra'];
  if (/\.(zip|tar|gz|xz|7z|rar|tgz)$/.test(name)) return ['Extraia aqui', 'Liste o conteúdo'];
  if (f.kind === 'application/pdf') return ['Resuma este PDF', 'Converta em texto', 'Junte com outro PDF'];
  if (f.kind.startsWith('image/')) return ['Converta para PNG', 'Reduza o tamanho', 'Quais as dimensões?'];
  if (f.kind.startsWith('video/') || f.kind.startsWith('audio/')) return ['Extraia o áudio em MP3', 'Reduza o tamanho', 'Quanto dura?'];
  if (f.kind.startsWith('text/') || /\.(md|json|ya?ml|csv|log|sh|py|ts|js|rs)$/.test(name)) return ['Resuma este arquivo', 'Encontre erros', 'Explique o que faz'];
  return ['O que é este arquivo?', 'Abra com o programa certo'];
}

const formatSize = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** Tela "solte o arquivo aqui": o Lumo de boca aberta; depois, "o que faço com isso?" */
/** Tamanho do Lumo esperando o arquivo e onde fica a boca (fração do tamanho, abaixo do centro) */
const WAIT_SIZE = 150;
const MOUTH_OFFSET = 0.22;
/** Intervalo do "aaaa" enquanto espera */
const EAGER_EVERY_MS = 2600;

/**
 * Esperando o arquivo: o Lumo, de boca bem aberta, persegue o arquivo pela janela
 * (a boca vai para baixo do cursor) e se inclina em 3D na direção do movimento.
 */
function Follower({ pointer, emotion, globalCursor, onGlobalCursorBroken }: Pick<Props, 'pointer' | 'emotion' | 'globalCursor' | 'onGlobalCursorBroken'>) {
  const areaRef = useRef<HTMLDivElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const target = useRef<{ x: number; y: number } | null>(null);
  const pos = useRef({ x: 0, y: 0, vx: 0, vy: 0, init: false });

  // alvo = ponto do arquivo, em coordenadas da área
  useEffect(() => {
    const area = areaRef.current;
    if (!area || !pointer) return;
    const r = area.getBoundingClientRect();
    target.current = { x: pointer.x - r.left, y: pointer.y - r.top };
  }, [pointer?.x, pointer?.y]); // eslint-disable-line react-hooks/exhaustive-deps

  // mola: o corpo persegue o alvo; a inclinação 3D vem da velocidade
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      const area = areaRef.current;
      const body = bodyRef.current;
      if (area && body) {
        const w = area.clientWidth;
        const h = area.clientHeight;
        const half = WAIT_SIZE / 2;
        const t = target.current ?? { x: w / 2, y: h / 2 + WAIT_SIZE * MOUTH_OFFSET };
        // a boca (não o centro) vai para o arquivo
        const tx = Math.min(w - half, Math.max(half, t.x));
        // corpo ocupa quase toda a altura: persegue na horizontal, só balança na vertical
        const ty = Math.min(h - half + 8, Math.max(half - 8, t.y - WAIT_SIZE * MOUTH_OFFSET));
        const p = pos.current;
        if (!p.init) Object.assign(p, { x: w / 2, y: h / 2, init: true });
        const k = reducedMotion() ? 1 : 0.14;
        p.vx = (tx - p.x) * k;
        p.vy = (ty - p.y) * k;
        p.x += p.vx;
        p.y += p.vy;
        const ry = Math.max(-35, Math.min(35, p.vx * 2.4));
        const rx = Math.max(-25, Math.min(25, -p.vy * 2.4));
        body.style.transform = `translate3d(${p.x - half}px, ${p.y - half}px, 0) rotateY(${ry}deg) rotateX(${rx}deg)`;
        body.style.setProperty('--tilt', `${ry}`);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  // "aaaaa" baixinho, de tempos em tempos, enquanto espera
  useEffect(() => {
    sound.playEager();
    const id = window.setInterval(() => sound.playEager(), EAGER_EVERY_MS);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div ref={areaRef} data-tauri-drag-region className="absolute inset-0 lumo-stage-3d">
      <div ref={bodyRef} className="absolute left-0 top-0 lumo-3d" style={{ width: WAIT_SIZE, height: WAIT_SIZE }}>
        <div data-anim="char" className="relative isolate w-full h-full">
          <Glow />
          <CharacterCanvas emotion={emotion} size={WAIT_SIZE} globalCursor={globalCursor} onGlobalCursorBroken={onGlobalCursorBroken} lookAt={pointer} interactive={false} />
          <span className="lumo-sheen" aria-hidden />
        </div>
      </div>
    </div>
  );
}

export function DropView({ files, pointer, emotion, globalCursor, onGlobalCursorBroken, onSubmit, onCancel }: Props) {
  const [task, setTask] = useState('');
  const charRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Caiu na boca: engole ("glub — nham!") e pergunta o que fazer
  useEffect(() => {
    if (!files) return;
    sound.playGulp();
    gulp(charRef.current);
    const id = window.setTimeout(() => inputRef.current?.focus(), 250);
    return () => window.clearTimeout(id);
  }, [files]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCancel();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  const submit = (text: string) => {
    if (text.trim()) onSubmit(text.trim());
  };

  if (!files) {
    return <Follower pointer={pointer} emotion="eager" globalCursor={globalCursor} onGlobalCursorBroken={onGlobalCursorBroken} />;
  }

  return (
    <div data-tauri-drag-region className="relative w-full h-full flex items-center gap-3 px-4 py-3">
      <div ref={charRef} data-anim="char" className="relative isolate shrink-0">
        <Glow />
        <CharacterCanvas emotion={emotion} size={76} globalCursor={globalCursor} onGlobalCursorBroken={onGlobalCursorBroken} />
      </div>

      {!files ? null : (
        <form
          className="min-w-0 flex-1 flex flex-col gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            submit(task);
          }}
        >
          <div className="flex items-center gap-1 flex-wrap">
            {files.slice(0, 3).map((f) => {
              const Icon = f.is_dir ? Folder : FileText;
              return (
                <span key={f.path} title={f.path} className="inline-flex items-center gap-1 max-w-[160px] h-5 px-1.5 rounded-full bg-white/10 text-[10px] text-slate-200">
                  <Icon className="w-3 h-3 shrink-0" />
                  <span className="truncate">{f.name}</span>
                  {!f.is_dir && <span className="text-slate-500 shrink-0">{formatSize(f.size)}</span>}
                </span>
              );
            })}
            {files.length > 3 && <span className="text-[10px] text-slate-500">+{files.length - 3}</span>}
            <button type="button" aria-label="Cancelar" onClick={onCancel} className="ml-auto p-0.5 rounded-full text-slate-500 hover:text-white">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
          <p className="text-[11px] text-slate-300">O que eu faço com {files.length > 1 ? 'eles' : 'isso'}?</p>
          <div className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              aria-label="O que fazer com o arquivo"
              value={task}
              onChange={(e) => setTask(e.target.value)}
              placeholder="ex.: converta para PDF"
              className="flex-1 min-w-0 bg-surface-2 border border-white/10 rounded-xl px-2.5 py-1 text-xs text-white placeholder-slate-600 focus:outline-none focus:border-white/30"
            />
            <button type="submit" aria-label="Enviar" disabled={!task.trim()} className="lumo-pill p-1.5 rounded-xl text-white disabled:opacity-40">
              <Send className="w-3 h-3" />
            </button>
          </div>
          <div className="flex gap-1 overflow-hidden">
            {suggestions(files).map((s) => (
              <button key={s} type="button" onClick={() => submit(s)} className="shrink-0 px-2 h-5 rounded-full bg-white/[0.06] hover:bg-white/15 text-[10px] text-slate-300">
                {s}
              </button>
            ))}
          </div>
        </form>
      )}
    </div>
  );
}
