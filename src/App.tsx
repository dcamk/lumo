import { SquarePen } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sound } from './audio/SoundEngine';
import type { CharacterEmotion } from './character/types';
import type { DragEndInfo } from './character/SpringDragCharacter';
import { CompactBar, type Notice } from './components/CompactBar';
import { DropView } from './components/DropView';
import { QuickPanel } from './components/QuickPanel';
import { ChatTab } from './components/tabs/ChatTab';
import { FocusTab } from './components/tabs/FocusTab';
import { LinuxTab } from './components/tabs/LinuxTab';
import { MailTab } from './components/tabs/MailTab';
import { SettingsPageSwitch, SettingsTab, type SettingsPage } from './components/tabs/SettingsTab';
import { TasksTab } from './components/tabs/TasksTab';
import { useAudioUnlock } from './hooks/useAudioUnlock';
import { useBrain } from './hooks/useBrain';
import { useChat } from './hooks/useChat';
import { useEmotion } from './hooks/useEmotion';
import { useFileDrop } from './hooks/useFileDrop';
import { gmailLink, useGoogle, type MailSummary } from './hooks/useGoogle';
import { usePomodoro } from './hooks/usePomodoro';
import { useSystemStats, type SystemAlert } from './hooks/useSystem';
import { useTasks } from './hooks/useTasks';
import { SHELL_RADIUS, useWindowMode } from './hooks/useWindowMode';
import { clampExtra, clampScale, type PanelExtra } from './lib/layout';
import { auraFlash, recalibrate, rimSweep, spin3d } from './lib/motion';
import { PROVIDERS, presetOf } from './lib/providers';
import { invoke, listen, tryInvoke } from './lib/tauri';
import { usePersistentState } from './lib/usePersistentState';
import { AssistToggle, TerminalTab } from './components/tabs/TerminalTab';
import { StyleTab } from './components/tabs/StyleTab';
import { isPaletteId, moodColor } from './theme/palettes';
import { isLook, setLook, setPalette, usePalette, useLook } from './theme/store';
import { DEFAULT_SETTINGS, type DroppedFile, type PanelTab, type Settings, type Task, type WindowMode } from './types';

/** Quanto tempo um aviso fica na pílula compacta */
const NOTICE_MS = 6000;

/** Configurações salvas por versões antigas → formato atual */
function migrateSettings(raw: Record<string, unknown>) {
  if (typeof raw.charScale === 'number' && raw.lumoScale === undefined) raw.lumoScale = clampScale(raw.charScale);
  // Ollama tinha um campo próprio; agora é um provedor como os outros
  const providers = (raw.providers ?? {}) as Record<string, unknown>;
  const ollama = raw.ollama as { endpoint?: string; model?: string } | undefined;
  if (ollama && !providers.ollama) providers.ollama = { endpoint: ollama.endpoint, model: ollama.model };
  raw.providers = providers;
  if (!isPaletteId(raw.palette)) raw.palette = DEFAULT_SETTINGS.palette;
  if (!isLook(raw.look)) raw.look = DEFAULT_SETTINGS.look;
  if (raw.voice !== 'auto' && raw.voice !== 'discreto' && raw.voice !== 'terminal' && raw.voice !== 'criatura') raw.voice = 'auto';
  // Provedor salvo que não existe mais → padrão
  if (!PROVIDERS.some((p) => p.id === raw.provider)) {
    raw.provider = DEFAULT_SETTINGS.provider;
  }
}

const openUrl = (url: string) => {
  void tryInvoke('open_url', { url }).then((r) => {
    if (r === null) window.open(url, '_blank', 'noopener'); // navegador comum (npm run dev)
  });
};

export default function App() {
  useAudioUnlock();

  const [settings, setSettings] = usePersistentState<Settings>('lumo.settings', DEFAULT_SETTINGS, migrateSettings);
  const updateSettings = useCallback(
    (patch: Partial<Settings>) => setSettings((prev) => ({ ...prev, ...patch })),
    [setSettings]
  );
  const palette = usePalette();
  const look = useLook();
  const [tab, setTab] = useState<PanelTab>('tasks');
  const [termAssist, setTermAssist] = useState(true);
  const [settingsPage, setSettingsPage] = useState<SettingsPage>('geral');
  const [notice, setNotice] = useState<Notice | null>(null);

  // Painel esticado pelo canto: valor salvo, ou o valor ao vivo enquanto arrasta
  const [liveExtra, setLiveExtra] = useState<PanelExtra | null>(null);
  const extra = liveExtra ?? clampExtra(settings.panelExtra);

  const scale = clampScale(settings.lumoScale);
  const { mode, modeRef, shellRef, contentRef, changeMode, size } = useWindowMode(scale, extra, notice !== null, liveExtra !== null);

  // ---- emoção ------------------------------------------------------------------------
  const flashRef = useRef<(e: CharacterEmotion, ms?: number) => void>(() => {});
  const flashNow = (e: CharacterEmotion, ms?: number) => flashRef.current(e, ms);

  // ---- avisos na pílula (e-mail, lembrete, sistema) -----------------------------------------
  const noticeTimer = useRef<number | undefined>(undefined);
  const showNotice = useCallback((n: Omit<Notice, 'id'>) => {
    if (modeRef.current !== 'compact') return; // no painel o conteúdo já está à vista
    setNotice({ ...n, id: crypto.randomUUID() });
    window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, [modeRef]);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);

  const systemNotify = (title: string, body: string) => void tryInvoke('notify', { title, body });

  // ---- Pomodoro --------------------------------------------------------------------------
  const pomodoro = usePomodoro((finished) => {
    sound.playAlert();
    flashNow('excited', 3000);
    // Notificação do sistema: aparece mesmo com o painel fechado
    systemNotify(
      finished === 'focus' ? 'Foco concluído' : 'Pausa encerrada',
      finished === 'focus' ? 'Sessão finalizada. Pausa de 5 minutos.' : 'Pausa encerrada. Retomar o foco?'
    );
  });

  // ---- chat --------------------------------------------------------------------------------
  const brain = useBrain(settings, tab === 'settings' && settingsPage === 'ia');
  // Painel no chat: aquece o modelo local para a primeira resposta não esperar o carregamento
  useEffect(() => {
    if (tab === 'chat') void tryInvoke('brain_warm');
  }, [tab]);
  const chat = useChat(settings, (ok) => {
    if (ok) {
      sound.playChirp();
      react('happy', 2000);
    } else {
      sound.playAlert();
      react('surprised', 1800);
    }
  });

  const baseEmotion: CharacterEmotion = chat.loading
    ? 'thinking'
    : pomodoro.running && pomodoro.phase === 'focus'
      ? 'focus'
      : 'idle';
  const [emotion, flash] = useEmotion(baseEmotion);
  flashRef.current = flash;

  // ---- reações: expressão + luz (aura acende, brilho corre pela borda) -------------------
  const rimRef = useRef<HTMLDivElement | null>(null);
  function react(e: CharacterEmotion, ms?: number) {
    flashRef.current(e, ms);
    auraFlash(shellRef.current);
    rimSweep(rimRef.current);
    // as grandes alegrias ganham o giro 3D
    if (e === 'excited') spin3d(shellRef.current);
  }
  useEffect(() => {
    if (notice) rimSweep(rimRef.current);
  }, [notice?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Comandos do agente: curioso esperando você, feliz quando dá certo, assustado no erro
  const seenStatus = useRef(new Map<string, string>());
  useEffect(() => {
    for (const m of chat.items) {
      if (m.kind !== 'command') continue;
      const before = seenStatus.current.get(m.id);
      if (before === m.status) continue;
      seenStatus.current.set(m.id, m.status);
      if (m.status === 'pending') react('curious', 2500);
      else if (m.status === 'done') react(m.code === 0 ? 'happy' : 'surprised', 1400);
    }
  }, [chat.items]); // eslint-disable-line react-hooks/exhaustive-deps

  // Digitando no chat: o Lumo presta atenção (no máximo a cada 4 s)
  const lastTyping = useRef(0);
  const onTyping = () => {
    if (Date.now() - lastTyping.current < 4000 || chat.loading) return;
    lastTyping.current = Date.now();
    flash('curious', 1500);
  };

  // ---- tarefas + lembretes -------------------------------------------------------------------
  const tasks = useTasks((task: Task) => {
    sound.playAlert();
    flash('excited', 2500);
    systemNotify('Lembrete', task.text);
    showNotice({ kind: 'reminder', title: 'Lembrete', text: task.text, action: () => openPanel('tasks') });
  });

  // ---- Google ---------------------------------------------------------------------------------
  const onNewMail = (mails: MailSummary[]) => {
    const first = mails[0];
    sound.playChirp(); // respeita o mudo
    flash('excited', 1800);
    showNotice({
      kind: 'mail',
      title: mails.length > 1 ? `${mails.length} e-mails novos · ${first.from}` : `E-mail de ${first.from || 'alguém'}`,
      text: first.subject || '(sem assunto)',
      action: () => openUrl(gmailLink(first)),
    });
    if (settings.mailNotify) {
      systemNotify(
        mails.length > 1 ? `${mails.length} e-mails novos` : `E-mail de ${first.from || 'alguém'}`,
        mails.map((m) => `${m.from}: ${m.subject || '(sem assunto)'}`).slice(0, 3).join('\n')
      );
    }
  };
  const google = useGoogle(settings.mailInterval, onNewMail);

  // ---- sistema ------------------------------------------------------------------------------
  const stats = useSystemStats(mode === 'quick' && tab === 'linux', settings.systemAlerts, (a: SystemAlert) => {
    sound.playAlert();
    flash('surprised', 2000);
    systemNotify(a.title, a.text);
    showNotice({ kind: 'system', title: a.title, text: a.text, action: () => openPanel('linux') });
  });

  // ---- navegação ---------------------------------------------------------------------------------
  const openPanel = (t: PanelTab, page?: SettingsPage) => {
    setTab(t);
    if (page) setSettingsPage(page);
    setNotice(null);
    void changeMode('quick');
  };

  useEffect(() => {
    sound.setVolume(settings.volume);
    sound.setMuted(settings.muted);
    sound.setOutput(settings.audioOutput);
  }, [settings.volume, settings.muted, settings.audioOutput]);

  // Paleta: cores + personalidade. Ao trocar, a casca "recalibra" e o Lumo reage.
  const firstPalette = useRef(true);
  useEffect(() => {
    setPalette(settings.palette);
    if (firstPalette.current) {
      firstPalette.current = false;
      return;
    }
    recalibrate(shellRef.current, rimRef.current);
    sound.playChirp();
    flashRef.current('curious', 1400);
  }, [settings.palette]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLook(settings.look);
  }, [settings.look]);

  useEffect(() => {
    sound.setStyle(settings.voice === 'auto' ? palette.voice : settings.voice);
  }, [settings.voice, palette.voice]);

  useEffect(() => {
    void tryInvoke('set_always_on_top', { enabled: settings.alwaysOnTop });
  }, [settings.alwaysOnTop]);

  // Saudação ao abrir, junto com a animação de abertura
  useEffect(() => {
    const id = window.setTimeout(() => {
      sound.playChirp();
      flash('excited', 1600);
    }, 650);
    return () => window.clearTimeout(id);
  }, [flash]);

  // Ações vindas do Rust: atalho global, ícone da bandeja e `lumo-assistant --toggle`
  const actionRef = useRef<(a: string) => void>(() => {});
  actionRef.current = (action: string) => {
    if (action === 'toggle') void changeMode(modeRef.current === 'compact' ? 'quick' : 'compact');
    else if (action.startsWith('tab:')) openPanel(action.slice(4) as PanelTab);
    else if (action.startsWith('ask:')) {
      openPanel('chat');
      void chat.send(action.slice(4));
    }
    else if (action.startsWith('notice:')) {
      // "Título | texto" — avisos vindos de fora (ex.: automação que vigia o repositório)
      const [title, ...rest] = action.slice(7).split('|');
      const text = rest.join('|').trim();
      sound.playChirp();
      flash('curious', 1800);
      showNotice({ kind: 'system', title: title.trim() || 'Aviso', text, action: () => void changeMode('quick') });
      systemNotify(title.trim() || 'Aviso', text);
    } else if (action === 'mute') setSettings((prev) => ({ ...prev, muted: !prev.muted }));
  };
  useEffect(() => {
    const off = listen<string>('lumo://action', (a) => actionRef.current(a));
    return () => void off.then((fn) => fn());
  }, []);

  // ---- arrastar arquivos até o Lumo (qualquer modo/aba) ---------------------------------------
  const [dropFiles, setDropFiles] = useState<DroppedFile[] | null>(null);
  const [dropPointer, setDropPointer] = useState<{ x: number; y: number } | null>(null);
  const dropFilesRef = useRef(dropFiles);
  dropFilesRef.current = dropFiles;
  const beforeDrop = useRef<WindowMode>('compact');
  const leaveTimer = useRef<number | undefined>(undefined);

  const cancelDrop = useCallback(() => {
    window.clearTimeout(leaveTimer.current);
    setDropFiles(null);
    if (modeRef.current === 'drop') void changeMode(beforeDrop.current);
  }, [changeMode, modeRef]);

  const dropHandlers = {
    onEnter: () => {
      window.clearTimeout(leaveTimer.current);
      if (modeRef.current === 'drop') return;
      beforeDrop.current = modeRef.current;
      setNotice(null);
      setDropFiles(null);
      void changeMode('drop');
    },
    onOver: (pos: { x: number; y: number }) => setDropPointer(pos),
    // Saiu sem soltar: espera um pouco (o cursor pode só ter passado pela borda)
    onLeave: () => {
      if (dropFilesRef.current) return;
      window.clearTimeout(leaveTimer.current);
      leaveTimer.current = window.setTimeout(cancelDrop, 400);
    },
    onDrop: async (paths: string[]) => {
      window.clearTimeout(leaveTimer.current);
      const files =
        (await tryInvoke<DroppedFile[]>('inspect_paths', { paths })) ??
        paths.map((p) => ({ path: p, name: p.split('/').pop() ?? p, size: 0, kind: '', is_dir: false }));
      if (modeRef.current !== 'drop') {
        beforeDrop.current = modeRef.current;
        void changeMode('drop');
      }
      setDropFiles(files);
      sound.playChirp();
      flash('happy', 1200);
    },
  };
  useFileDrop(dropHandlers);

  // Teste sem arrastar de verdade (console do WebView): lumoDebug.drop(['/caminho/arquivo.pdf'])
  const dropHandlersRef = useRef(dropHandlers);
  dropHandlersRef.current = dropHandlers;
  useEffect(() => {
    if (!window.lumoDebug) return;
    window.lumoDebug.drop = (paths: string[]) => {
      dropHandlersRef.current.onEnter();
      window.setTimeout(() => void dropHandlersRef.current.onDrop(paths), 900);
    };
    // lumoDebug.dragOver(x, y): simula o arquivo se movendo (sem soltar)
    window.lumoDebug.dragOver = (x: number, y: number) => {
      if (modeRef.current !== 'drop') dropHandlersRef.current.onEnter();
      dropHandlersRef.current.onOver({ x, y });
    };
  });

  const submitDrop = (task: string) => {
    const files = dropFiles ?? undefined;
    setDropFiles(null);
    setTab('chat');
    void changeMode('quick');
    sound.playPop();
    void chat.send(task, files);
  };

  const sendToDrive = async (file: DroppedFile) => {
    try {
      const link = await invoke<string>('drive_upload', {
        name: file.name,
        mime: file.kind || 'application/octet-stream',
        path: file.path,
        dataBase64: null,
      });
      chat.note(`Enviado ao Drive: ${file.name}${link ? `\n${link}` : ''}`);
      sound.playChirp();
    } catch (err) {
      chat.note(`Não consegui enviar ao Drive. ${String(err)}`);
      sound.playAlert();
    }
  };

  // ---- redimensionar o painel pelo canto ---------------------------------------------------
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const start = { x: e.screenX, y: e.screenY };
    const base = clampExtra(settings.panelExtra);
    let last = base;
    setLiveExtra(base);
    const move = (ev: PointerEvent) => {
      // o painel é centralizado: cresce para os dois lados, então a largura anda 2×
      last = clampExtra({ w: base.w + (ev.screenX - start.x) * 2, h: base.h + (ev.screenY - start.y) });
      setLiveExtra(last);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      updateSettings({ panelExtra: last });
      setLiveExtra(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // ---- personagem -------------------------------------------------------------------------------
  // Clique simples abre o painel; rajada de cliques é só para irritar o Lumo
  const expandTimer = useRef<number | undefined>(undefined);
  const handleCompactClick = (burst: number) => {
    window.clearTimeout(expandTimer.current);
    if (burst >= 3) return;
    expandTimer.current = window.setTimeout(() => void changeMode('quick'), 300);
  };
  useEffect(() => () => window.clearTimeout(expandTimer.current), []);

  const dragHandlers = {
    onDragStart: () => flash('curious', 60_000),
    onDragEnd: ({ shakes, outside }: DragEndInfo) => {
      if (outside) {
        sound.playPop();
        flash('curious', 900);
      } else if (shakes >= 4) {
        sound.playDizzy();
        flash('dizzy', 2800);
      } else {
        sound.playPop();
        flash('happy', 900);
      }
    },
  };

  const cursorProps = {
    globalCursor: settings.cursorMode === 'screen',
    // Coordenadas globais erradas (ex.: olhos presos num canto) → volta para "só Lumo"
    onGlobalCursorBroken: () => updateSettings({ cursorMode: 'lumo' }),
  };

  // ---- tarefas -----------------------------------------------------------------------------------
  const toggleTask = (id: string) => {
    const task = tasks.tasks.find((t) => t.id === id);
    tasks.toggle(id);
    if (task && !task.completed) {
      sound.playChirp();
      const allDone = tasks.tasks.every((t) => t.id === id || t.completed);
      react(allDone ? 'excited' : 'happy', allDone ? 3000 : 1800);
    } else {
      sound.playPop();
    }
  };

  const addTask = (text: string) => {
    sound.playPop();
    if (tasks.add(text).remindAt) flash('happy', 1200);
  };

  return (
    <div
      className="w-screen h-screen overflow-hidden bg-transparent select-none font-sans text-slate-200 flex justify-center items-start"
      // Arrastar a janela pela área vazia: avisa o Rust para salvar a posição final
      onPointerDownCapture={(e) => {
        if ((e.target as HTMLElement).hasAttribute?.('data-tauri-drag-region')) void tryInvoke('begin_user_move');
      }}
    >
      {/* Casca preta: muda de tamanho com mola (lib/motion.ts) — a janela nativa não */}
      <div
        ref={shellRef}
        className={`lumo-shell relative shrink-0 overflow-hidden border-x border-b lumo-mood-${emotion}`}
        style={{
          borderRadius: `0 0 ${SHELL_RADIUS[mode]}px ${SHELL_RADIUS[mode]}px`,
          ['--mood' as string]: moodColor(palette, emotion),
        }}
      >
      <div ref={rimRef} className="lumo-rim z-10" aria-hidden />
      {/* Conteúdo no tamanho final, centralizado: a casca só "revela" enquanto estica */}
      <div
        key={mode}
        ref={contentRef}
        className="absolute top-0"
        style={{ width: size.width, height: size.height, left: '50%', marginLeft: -size.width / 2 }}
      >
        {mode === 'drop' && (
          <DropView
            files={dropFiles}
            pointer={dropPointer}
            emotion={emotion}
            onSubmit={submitDrop}
            onCancel={cancelDrop}
            {...cursorProps}
          />
        )}

        {mode === 'compact' && (
          <CompactBar
            emotion={emotion}
            lumoScale={scale}
            notice={notice}
            onNoticeDismiss={() => setNotice(null)}
            badge={google.unread}
            onCharacterClick={handleCompactClick}
            {...cursorProps}
            {...dragHandlers}
          />
        )}

        {mode === 'quick' && (
          <QuickPanel
            tab={tab}
            onTabChange={(t) => {
              sound.playPop();
              setTab(t);
              // cada aba tem um "jeito": foco concentra, IA fica curioso, o resto sorri
              flash(t === 'focus' ? 'focus' : t === 'chat' ? 'curious' : 'happy', 900);
            }}
            onCollapse={() => void changeMode('compact')}
            counts={{ mail: google.unread }}
            headerAccessory={
              tab === 'settings' ? (
                <SettingsPageSwitch page={settingsPage} onChange={setSettingsPage} />
              ) : tab === 'terminal' ? (
                <AssistToggle on={termAssist} onChange={setTermAssist} />
              ) : tab === 'chat' && chat.items.length > 1 ? (
                <button
                  type="button"
                  onClick={() => {
                    sound.playPop();
                    chat.clear();
                  }}
                  title="Começar uma conversa nova (o Lumo esquece esta)"
                  className="inline-flex items-center gap-1 h-6 px-2 rounded-full text-[11px] text-slate-400 hover:text-white hover:bg-white/[0.08] transition-colors"
                >
                  <SquarePen className="w-3 h-3" /> Nova conversa
                </button>
              ) : null
            }
            emotion={emotion}
            lumoScale={scale}
            onResizeStart={startResize}
            onResizeReset={() => updateSettings({ panelExtra: { w: 0, h: 0 } })}
            {...cursorProps}
            {...dragHandlers}
          >
            {tab === 'tasks' && (
              <TasksTab
                tasks={tasks.tasks}
                onToggle={toggleTask}
                onAdd={addTask}
                onDelete={(id) => {
                  sound.playPop();
                  tasks.remove(id);
                }}
                onClearDone={() => {
                  sound.playPop();
                  tasks.clearDone();
                }}
              />
            )}
            {tab === 'focus' && (
              <FocusTab
                {...pomodoro}
                onToggle={() => {
                  sound.playPop();
                  if (!pomodoro.running && pomodoro.phase === 'focus') sound.playPurr();
                  pomodoro.toggle();
                }}
                onSelectPhase={(p) => {
                  sound.playPop();
                  pomodoro.selectPhase(p);
                }}
              />
            )}
            {tab === 'chat' && (
              <ChatTab
                items={chat.items}
                loading={chat.loading}
                providerLabel={presetOf(settings.provider).label}
                onSend={(text) => {
                  sound.playPop();
                  void chat.send(text);
                }}
                onApprove={chat.approve}
                onStop={chat.stop}
                onTyping={onTyping}
                driveEnabled={!!google.status?.connected}
                onSendToDrive={sendToDrive}
              />
            )}
            {tab === 'mail' && <MailTab google={google} onOpen={openUrl} onSetup={() => openPanel('settings', 'contas')} />}
            {tab === 'linux' && (
              <LinuxTab
                stats={stats}
                actions={settings.quickActions}
                onActionsChange={(quickActions) => updateSettings({ quickActions })}
                onActionDone={(ok) => {
                  if (ok) {
                    sound.playChirp();
                    react('happy', 1200);
                  } else {
                    sound.playAlert();
                    react('surprised', 1500);
                  }
                }}
              />
            )}
            {tab === 'terminal' && (
              <TerminalTab
                settings={settings}
                assist={termAssist}
                onCommandDone={(ok) => {
                  if (!ok) {
                    sound.playAlert();
                    react('surprised', 1200);
                  }
                }}
              />
            )}
            {tab === 'style' && (
              <StyleTab
                palette={palette}
                voice={settings.voice}
                look={look}
                onLook={(l) => updateSettings({ look: l })}
                onPalette={(id) => updateSettings({ palette: id })}
                onVoice={(voice) => {
                  updateSettings({ voice });
                  window.setTimeout(() => sound.playChirp(), 60);
                }}
              />
            )}
            {tab === 'settings' && (
              <SettingsTab page={settingsPage} settings={settings} onChange={updateSettings} google={google} onOpen={openUrl} brain={brain} />
            )}
          </QuickPanel>
        )}
      </div>
      </div>
    </div>
  );
}
