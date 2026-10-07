// Nuvem pessoal guardada no PC (~/Lumo Nuvem): arquivos em pastas e notas no banco de dados.
import { ArrowLeft, Camera, ChevronRight, File as FileIcon, Folder, FolderPlus, MoreHorizontal, NotebookPen, Plus, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { formatBytes, haptic, type Bridge, type CloudEntry, type CloudList, type Doc } from '../lib/bridge';
import { uid } from '../lib/uid';

type Section = 'arquivos' | 'notas';

const spring = { type: 'spring', stiffness: 380, damping: 34 } as const;

export function Cloud({ bridge, toast, onSent }: { bridge: Bridge; toast: (t: string) => void; onSent: () => void }) {
  const [section, setSection] = useState<Section>('arquivos');
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pb-3">
        <h2 className="text-xl font-semibold tracking-tight">Nuvem</h2>
        <div className="relative flex rounded-full bg-surface-2 p-1" role="tablist">
          {(['arquivos', 'notas'] as const).map((s) => (
            <button key={s} type="button" role="tab" aria-selected={section === s} onClick={() => setSection(s)} className="relative px-4 py-1.5 text-[13px] font-medium capitalize">
              {section === s && <motion.span layoutId="cloud-seg" className="absolute inset-0 rounded-full bg-surface-3 shadow-sm" transition={spring} />}
              <span className={`relative ${section === s ? 'text-ink' : 'text-muted'}`}>{s}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={section}
            className="absolute inset-0"
            initial={{ opacity: 0, x: section === 'notas' ? 16 : -16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: section === 'notas' ? -16 : 16 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          >
            {section === 'arquivos' ? <Files bridge={bridge} toast={toast} onSent={onSent} /> : <Notes bridge={bridge} toast={toast} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---- Arquivos ---------------------------------------------------------------------------

interface Upload {
  id: string;
  name: string;
  progress: number;
  state: 'sending' | 'done' | 'error';
}

const isImage = (name: string) => /\.(jpe?g|png|gif|webp|avif)$/i.test(name);

function Files({ bridge, toast, onSent }: { bridge: Bridge; toast: (t: string) => void; onSent: () => void }) {
  const [path, setPath] = useState('');
  const [data, setData] = useState<CloudList | null>(null);
  const [loading, setLoading] = useState(false);
  const [dir, setDir] = useState(1); // direção da animação ao entrar/sair de pastas
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [menu, setMenu] = useState<CloudEntry | null>(null);
  const [preview, setPreview] = useState<CloudEntry | null>(null);
  const [ask, setAsk] = useState<{ title: string; value: string; onOk: (v: string) => void } | null>(null);
  const pickMedia = useRef<HTMLInputElement>(null);
  const pickFile = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (p = path) => {
      setLoading(true);
      try {
        setData(await bridge.list(p));
      } catch (err) {
        toast(err instanceof Error ? err.message : String(err));
      }
      setLoading(false);
    },
    [bridge, path, toast]
  );

  useEffect(() => {
    void load(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const open = (p: string, forward: boolean) => {
    haptic(6);
    setDir(forward ? 1 : -1);
    setPath(p);
  };

  const send = async (list: FileList | null) => {
    if (!list?.length) return;
    const folder = path;
    for (const file of Array.from(list)) {
      const id = uid();
      setUploads((u): Upload[] => [...u, { id, name: file.name, progress: 0, state: 'sending' as const }]);
      try {
        await bridge.upload(file, folder, (p) => setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: p } : x))));
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, progress: 1, state: 'done' } : x)));
        onSent();
      } catch (err) {
        setUploads((u) => u.map((x) => (x.id === id ? { ...x, state: 'error' } : x)));
        toast(err instanceof Error ? err.message : String(err));
      }
    }
    haptic(15);
    void load(folder);
    // Some com os concluídos depois de um respiro
    window.setTimeout(() => setUploads((u) => u.filter((x) => x.state === 'sending')), 1800);
  };

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok);
      void load();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const crumbs = path ? path.split('/') : [];
  const usedPct = data ? Math.min(100, (data.used / Math.max(1, data.used + data.free)) * 100) : 0;

  return (
    <div className="m-scroll flex h-full flex-col gap-3 px-4 pb-4">
      {/* Caminho */}
      <div className="flex min-h-9 items-center gap-1 overflow-x-auto text-[14px]">
        {path && (
          <button type="button" className="m-icon-btn mr-1" onClick={() => open(crumbs.slice(0, -1).join('/'), false)} aria-label="Voltar">
            <ArrowLeft className="h-4 w-4" />
          </button>
        )}
        <button type="button" className={`shrink-0 ${path ? 'text-muted' : 'font-medium'}`} onClick={() => open('', false)}>
          Lumo Nuvem
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="flex shrink-0 items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted" />
            <button type="button" className={i === crumbs.length - 1 ? 'font-medium' : 'text-muted'} onClick={() => open(crumbs.slice(0, i + 1).join('/'), false)}>
              {c}
            </button>
          </span>
        ))}
        <button type="button" className="m-icon-btn ml-auto" onClick={() => void load()} aria-label="Atualizar">
          <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Ações */}
      <div className="grid grid-cols-3 gap-2">
        <button type="button" className="m-btn" onClick={() => pickMedia.current?.click()}>
          <Camera className="h-4 w-4" /> Fotos
        </button>
        <button type="button" className="m-btn" onClick={() => pickFile.current?.click()}>
          <Upload className="h-4 w-4" /> Arquivos
        </button>
        <button
          type="button"
          className="m-btn"
          onClick={() => setAsk({ title: 'Nova pasta', value: '', onOk: (v) => void act(() => bridge.post('/api/cloud/mkdir', { path: [path, v].filter(Boolean).join('/') })) })}
        >
          <FolderPlus className="h-4 w-4" /> Pasta
        </button>
      </div>
      <input ref={pickMedia} type="file" accept="image/*,video/*" multiple hidden onChange={(e) => void send(e.target.files).then(() => (e.target.value = ''))} />
      <input ref={pickFile} type="file" multiple hidden onChange={(e) => void send(e.target.files).then(() => (e.target.value = ''))} />

      {/* Envios em andamento */}
      <AnimatePresence initial={false}>
        {uploads.map((u) => (
          <motion.div key={u.id} layout initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="m-card relative overflow-hidden px-3.5 py-2.5 text-[13px]">
              <motion.div className={`absolute inset-y-0 left-0 ${u.state === 'error' ? 'bg-danger/15' : 'bg-accent/12'}`} animate={{ width: `${Math.round(u.progress * 100)}%` }} transition={{ ease: 'easeOut' }} />
              <div className="relative flex justify-between gap-3">
                <span className="truncate">{u.name}</span>
                <span className="shrink-0 tabular-nums text-muted">{u.state === 'error' ? 'falhou' : u.state === 'done' ? 'enviado' : `${Math.round(u.progress * 100)}%`}</span>
              </div>
            </div>
          </motion.div>
        ))}
      </AnimatePresence>

      {/* Conteúdo da pasta */}
      <AnimatePresence mode="wait" initial={false} custom={dir}>
        <motion.div
          key={path}
          custom={dir}
          initial={{ opacity: 0, x: 24 * dir }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -24 * dir }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
        >
          {data && data.path === path && data.entries.length === 0 && <p className="py-8 text-center text-[14px] text-muted sm:col-span-2">Pasta vazia</p>}
          {data?.path === path &&
            data.entries.map((e) => (
              <div key={e.path} className="m-row flex items-center gap-3 rounded-2xl px-2 py-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                  onClick={() => (e.is_dir ? open(e.path, true) : isImage(e.name) ? setPreview(e) : window.open(bridge.fileUrl(e.path), '_blank'))}
                >
                  {e.is_dir ? (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-accent/12">
                      <Folder className="h-5 w-5 text-accent" />
                    </span>
                  ) : isImage(e.name) && e.size < 15 * 1048576 ? (
                    <img src={bridge.fileUrl(e.path, true)} alt="" loading="lazy" className="h-11 w-11 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-xl bg-surface-3">
                      <FileIcon className="h-5 w-5 text-muted" />
                    </span>
                  )}
                  <span className="min-w-0">
                    <span className="block truncate text-[15px]">{e.name}</span>
                    <span className="block text-[12px] text-muted">{e.is_dir ? 'Pasta' : formatBytes(e.size)}</span>
                  </span>
                </button>
                <button type="button" className="m-icon-btn" onClick={() => setMenu(e)} aria-label={`Opções de ${e.name}`}>
                  <MoreHorizontal className="h-4 w-4" />
                </button>
              </div>
            ))}
        </motion.div>
      </AnimatePresence>

      {/* Espaço */}
      {data && (
        <div className="mt-auto pt-2">
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
            <motion.div className="h-full rounded-full bg-accent" initial={{ width: 0 }} animate={{ width: `${Math.max(1, usedPct)}%` }} transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }} />
          </div>
          <p className="mt-1.5 text-[12px] text-muted">
            {formatBytes(data.used)} usados · {formatBytes(data.free)} livres no PC
          </p>
        </div>
      )}

      {/* Opções de um item */}
      <Sheet open={!!menu} onClose={() => setMenu(null)}>
        {menu && (
          <div className="flex flex-col gap-1">
            <p className="truncate px-2 pb-2 text-[15px] font-medium">{menu.name}</p>
            {!menu.is_dir && (
              <a className="m-sheet-item" href={bridge.fileUrl(menu.path)} download={menu.name} onClick={() => setMenu(null)}>
                Baixar no celular
              </a>
            )}
            <button
              type="button"
              className="m-sheet-item"
              onClick={() => {
                const m = menu;
                setMenu(null);
                setAsk({ title: 'Renomear', value: m.name, onOk: (v) => void act(() => bridge.post('/api/cloud/rename', { path: m.path, name: v })) });
              }}
            >
              Renomear
            </button>
            <button
              type="button"
              className="m-sheet-item text-danger"
              onClick={() => {
                const m = menu;
                setMenu(null);
                void act(() => bridge.post('/api/cloud/delete', { path: m.path }), 'Movido para a lixeira da nuvem.');
              }}
            >
              <Trash2 className="h-4 w-4" /> Apagar
            </button>
          </div>
        )}
      </Sheet>

      {/* Pedir um nome (nova pasta, renomear) */}
      <Sheet open={!!ask} onClose={() => setAsk(null)}>
        {ask && (
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              const v = ask.value.trim();
              if (!v) return;
              ask.onOk(v);
              setAsk(null);
            }}
          >
            <p className="px-1 text-[15px] font-medium">{ask.title}</p>
            <input autoFocus className="m-input" value={ask.value} onChange={(e) => setAsk({ ...ask, value: e.target.value })} />
            <button type="submit" className="m-btn m-btn-solid" disabled={!ask.value.trim()}>
              Salvar
            </button>
          </form>
        )}
      </Sheet>

      {/* Foto em tela cheia */}
      <AnimatePresence>
        {preview && (
          <motion.div className="fixed inset-0 z-50 grid place-items-center bg-black/90 p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setPreview(null)}>
            <motion.img
              src={bridge.fileUrl(preview.path, true)}
              alt={preview.name}
              className="max-h-full max-w-full rounded-xl object-contain"
              initial={{ scale: 0.94, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.96, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
            />
            <button type="button" className="absolute right-4 top-[calc(var(--safe-top)+12px)] grid h-10 w-10 place-items-center rounded-full bg-white/15 text-white" aria-label="Fechar">
              <X className="h-5 w-5" />
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ---- Notas (banco de dados) -------------------------------------------------------------------

interface Note {
  title: string;
  body: string;
}

const NOTES_CACHE = 'lumo.mobile.notes';

function Notes({ bridge, toast }: { bridge: Bridge; toast: (t: string) => void }) {
  const [notes, setNotes] = useState<Doc<Note>[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(NOTES_CACHE) ?? '[]') as Doc<Note>[];
    } catch {
      return [];
    }
  });
  const [offline, setOffline] = useState(false);
  const [edit, setEdit] = useState<Doc<Note> | null>(null);

  const keep = (list: Doc<Note>[]) => {
    setNotes(list);
    try {
      localStorage.setItem(NOTES_CACHE, JSON.stringify(list));
    } catch {
      /* sem espaço */
    }
  };

  const load = useCallback(async () => {
    try {
      const r = await bridge.dbList<Note>('notas');
      keep(r.docs);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [bridge]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (d: Doc<Note>) => {
    const data = { title: d.data.title.trim(), body: d.data.body };
    if (!data.title && !data.body.trim()) return;
    try {
      const r = await bridge.dbPut('notas', d.id, data);
      keep([{ id: d.id, data, updated: r.updated }, ...notes.filter((n) => n.id !== d.id)]);
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  const remove = async (id: string) => {
    try {
      await bridge.dbDelete('notas', id);
      keep(notes.filter((n) => n.id !== id));
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="m-scroll flex h-full flex-col gap-2 px-4 pb-4">
      <button type="button" className="m-btn m-btn-solid" onClick={() => setEdit({ id: uid().replace(/[^a-z0-9-]/gi, ''), data: { title: '', body: '' }, updated: 0 })} disabled={offline}>
        <Plus className="h-4 w-4" /> Nova nota
      </button>
      {offline && <p className="text-[13px] text-muted">Sem conexão com o PC: mostrando a última cópia.</p>}
      {notes.length === 0 && !offline && (
        <div className="flex flex-col items-center gap-2 py-10 text-muted">
          <NotebookPen className="h-6 w-6" />
          <p className="text-[14px]">As notas ficam guardadas no PC.</p>
        </div>
      )}
      <motion.div layout className="grid gap-2 sm:grid-cols-2">
        <AnimatePresence initial={false}>
          {notes.map((n) => (
            <motion.button
              layout
              key={n.id}
              type="button"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={spring}
              className="m-card p-4 text-left"
              onClick={() => !offline && setEdit(n)}
            >
              <div className="truncate text-[15px] font-medium">{n.data.title || n.data.body.split('\n')[0] || 'Sem título'}</div>
              {n.data.body && <div className="mt-1 line-clamp-3 whitespace-pre-wrap text-[13px] text-muted">{n.data.body}</div>}
              <div className="mt-2 text-[11px] text-muted">{new Date(n.updated * 1000).toLocaleString('pt-BR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}</div>
            </motion.button>
          ))}
        </AnimatePresence>
      </motion.div>

      <Sheet open={!!edit} onClose={() => (edit && void save(edit), setEdit(null))} tall>
        {edit && (
          <div className="flex h-full flex-col gap-2">
            <div className="flex items-center gap-2">
              <input className="m-input flex-1 border-transparent bg-transparent px-1 text-lg font-semibold" placeholder="Título" value={edit.data.title} onChange={(e) => setEdit({ ...edit, data: { ...edit.data, title: e.target.value } })} />
              {edit.updated > 0 && (
                <button
                  type="button"
                  className="m-icon-btn text-danger"
                  aria-label="Apagar nota"
                  onClick={() => {
                    void remove(edit.id);
                    setEdit(null);
                  }}
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              )}
            </div>
            <textarea
              autoFocus
              className="m-input min-h-0 flex-1 resize-none border-transparent bg-transparent px-1"
              placeholder="Escreva aqui…"
              value={edit.data.body}
              onChange={(e) => setEdit({ ...edit, data: { ...edit.data, body: e.target.value } })}
            />
            <button
              type="button"
              className="m-btn m-btn-solid"
              onClick={() => {
                void save(edit);
                setEdit(null);
              }}
            >
              Salvar no PC
            </button>
          </div>
        )}
      </Sheet>
    </div>
  );
}

/** Folha que sobe de baixo (celular) ou aparece centralizada (tablet) */
export function Sheet({ open, onClose, children, tall = false }: { open: boolean; onClose: () => void; children: React.ReactNode; tall?: boolean }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} />
          <motion.div
            className={`m-sheet fixed inset-x-0 bottom-0 z-50 mx-auto flex w-full max-w-lg flex-col p-4 md:bottom-auto md:top-[12vh] md:rounded-3xl ${tall ? 'h-[80vh] md:h-[70vh]' : ''}`}
            style={{ paddingBottom: 'calc(var(--safe-bottom) + 16px)' }}
            initial={{ y: 40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 420, damping: 38 }}
            role="dialog"
          >
            <div className="mx-auto mb-3 h-1 w-10 shrink-0 rounded-full bg-line-strong md:hidden" />
            {children}
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}
