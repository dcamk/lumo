// Troca de arquivos: o celular manda para ~/Downloads/Lumo no PC e baixa o que estiver lá
import { Camera, CheckCircle2, Download, FileUp, FolderOpen, RefreshCw, XCircle } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, haptic, type Bridge, type SharedFile } from '../lib/bridge';
import { uid } from '../lib/uid';

interface Upload {
  id: string;
  name: string;
  size: number;
  progress: number;
  state: 'sending' | 'done' | 'error';
  error?: string;
}

const when = (secs: number) => {
  const d = new Date(secs * 1000);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
};

export function Files({ bridge, toast, onSent }: { bridge: Bridge; toast: (t: string) => void; onSent: () => void }) {
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [files, setFiles] = useState<SharedFile[]>([]);
  const [dir, setDir] = useState('');
  const [loading, setLoading] = useState(false);
  const [drag, setDrag] = useState(false);
  const pickFile = useRef<HTMLInputElement>(null);
  const pickPhoto = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const r = await bridge.get<{ dir: string; files: SharedFile[] }>('/api/files');
      setFiles(r.files);
      setDir(r.dir);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
    setLoading(false);
  }, [bridge, toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const send = async (list: FileList | File[] | null) => {
    if (!list?.length) return;
    haptic(12);
    // Um por vez: no Wi-Fi do celular isso é mais estável que vários em paralelo
    for (const file of Array.from(list)) {
      const id = uid();
      setUploads((u): Upload[] => [{ id, name: file.name, size: file.size, progress: 0, state: 'sending' as const }, ...u].slice(0, 20));
      try {
        const res = await bridge.upload(file, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))));
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, name: res.name, progress: 1, state: 'done' } : x)));
        onSent();
      } catch (err) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'error', error: err instanceof Error ? err.message : String(err) } : x)));
      }
    }
    haptic(25);
    void refresh();
  };

  return (
    <div
      className="m-scroll flex h-full flex-col gap-4 px-4 pb-4"
      onDragOver={(e) => {
        e.preventDefault();
        setDrag(true);
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        void send(e.dataTransfer.files);
      }}
    >
      <h2 className="text-xl font-bold">Arquivos</h2>

      <div className={`grid grid-cols-2 gap-3 rounded-[24px] transition ${drag ? 'ring-2 ring-accent' : ''}`}>
        <motion.button whileTap={{ scale: 0.95 }} type="button" className="m-card flex flex-col items-center gap-2 p-5" onClick={() => pickPhoto.current?.click()}>
          <Camera className="h-7 w-7 text-accent" />
          <span className="font-semibold">Foto ou vídeo</span>
          <span className="text-[12px] text-muted">câmera ou galeria</span>
        </motion.button>
        <motion.button whileTap={{ scale: 0.95 }} type="button" className="m-card flex flex-col items-center gap-2 p-5" onClick={() => pickFile.current?.click()}>
          <FileUp className="h-7 w-7 text-accent" />
          <span className="font-semibold">Arquivos</span>
          <span className="text-[12px] text-muted">qualquer tipo</span>
        </motion.button>
      </div>
      <input ref={pickPhoto} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void send(e.target.files).then(() => (e.target.value = ''))} />
      <input ref={pickFile} type="file" multiple hidden onChange={(e) => void send(e.target.files).then(() => (e.target.value = ''))} />

      <AnimatePresence initial={false}>
        {uploads.length > 0 && (
          <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="flex flex-col gap-2">
            <span className="m-label">Enviando para o PC</span>
            {uploads.map((u) => (
              <motion.div key={u.id} layout initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} className="m-card relative overflow-hidden px-3.5 py-3">
                <motion.div className="absolute inset-y-0 left-0 bg-accent/15" animate={{ width: `${Math.round(u.progress * 100)}%` }} transition={{ ease: 'easeOut' }} />
                <div className="relative flex items-center gap-3">
                  {u.state === 'done' ? <CheckCircle2 className="h-5 w-5 text-ok" /> : u.state === 'error' ? <XCircle className="h-5 w-5 text-danger" /> : <span className="w-5 text-center text-[12px] tabular-nums">{Math.round(u.progress * 100)}</span>}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-medium">{u.name}</div>
                    <div className="text-[12px] text-muted">{u.state === 'error' ? u.error : formatBytes(u.size)}</div>
                  </div>
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <span className="m-label flex items-center gap-1.5">
            <FolderOpen className="h-3.5 w-3.5" /> No PC
          </span>
          {dir && <div className="truncate text-[12px] text-muted">{dir.replace(/^\/home\/[^/]+/, '~')}</div>}
        </div>
        <button type="button" className="m-btn min-h-9 px-3" onClick={() => void refresh()} aria-label="Atualizar lista">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {files.length === 0 && !loading && <p className="text-center text-[14px] text-muted">Nada por aqui. Coloque arquivos nessa pasta do PC para baixá-los no celular.</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {files.map((f, i) => (
          <motion.a
            key={f.name}
            href={bridge.downloadUrl(f.name)}
            download={f.name}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: Math.min(i, 12) * 0.03 }}
            className="m-card flex items-center gap-3 px-3.5 py-3 active:scale-[0.98]"
          >
            <Thumb bridge={bridge} file={f} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium">{f.name}</div>
              <div className="text-[12px] text-muted">
                {formatBytes(f.size)} · {when(f.modified)}
              </div>
            </div>
            <Download className="h-5 w-5 shrink-0 text-accent" />
          </motion.a>
        ))}
      </div>
    </div>
  );
}

/** Miniatura para imagens (o próprio arquivo, carregado sob demanda); ícone para o resto */
function Thumb({ bridge, file }: { bridge: Bridge; file: SharedFile }) {
  const isImage = /\.(jpe?g|png|gif|webp)$/i.test(file.name) && file.size < 15 * 1048576;
  if (!isImage) {
    const ext = file.name.includes('.') ? file.name.split('.').pop()!.slice(0, 4).toUpperCase() : '—';
    return <div className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-3 text-[11px] font-bold text-muted">{ext}</div>;
  }
  return <img src={bridge.downloadUrl(file.name)} alt="" loading="lazy" className="h-11 w-11 shrink-0 rounded-xl object-cover" />;
}
