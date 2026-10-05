import { ExternalLink, Volume2, VolumeX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { listModels } from '../../api/aiService';
import { sound, type AudioDiagnostics } from '../../audio/SoundEngine';
import type { GoogleControls } from '../../hooks/useGoogle';
import { SCALE_MAX, SCALE_MIN } from '../../lib/layout';
import { shake } from '../../lib/motion';
import { GROUP_LABEL, PROVIDERS, presetOf, providerConfig } from '../../lib/providers';
import { invoke, isTauri, tryInvoke } from '../../lib/tauri';
import type { CursorMode, ProviderConfig, ProviderId, Settings } from '../../types';

export type SettingsPage = 'geral' | 'ia' | 'contas' | 'sistema';

const PAGES: { key: SettingsPage; label: string }[] = [
  { key: 'geral', label: 'Geral' },
  { key: 'ia', label: 'IA' },
  { key: 'contas', label: 'Contas' },
  { key: 'sistema', label: 'Sistema' },
];

interface CursorExtensionStatus {
  session: 'gnome-wayland' | 'gnome-x11' | 'outro';
  installed: boolean;
  enabled: boolean;
  active: boolean;
}

interface ShortcutStatus {
  gnome: boolean;
  installed: boolean;
  binding: string;
}

// Mesmo formato dos campos das abas Tarefas/IA
const inputCls =
  'min-w-0 bg-surface-2 border border-white/5 rounded-xl px-2.5 py-1 text-[11px] text-white placeholder-slate-600 focus:outline-none focus:border-white/20';
const rowCls = 'flex items-center gap-2 min-h-7';
const labelCls = 'w-[76px] shrink-0 text-slate-400';
const chipCls = (on: boolean) =>
  `px-2.5 h-6 rounded-full text-[11px] font-medium transition-colors ${on ? 'bg-white/15 text-white' : 'text-slate-400 hover:text-white'}`;
const smallBtn =
  'shrink-0 inline-flex items-center gap-1 px-2.5 h-6 rounded-full bg-white/10 hover:bg-white/20 text-white text-[11px] disabled:opacity-40 transition-colors';
const hintCls = 'text-[10px] text-slate-500 leading-snug';

function Toggle({ on, onToggle, label }: { on: boolean; onToggle: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onToggle}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${on ? 'lumo-pill' : 'bg-white/15'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${on ? 'translate-x-5' : 'translate-x-1'}`} />
    </button>
  );
}

/** Seletor de página (vai no cabeçalho do painel, ao lado de "CONFIG") */
export function SettingsPageSwitch({ page, onChange }: { page: SettingsPage; onChange: (p: SettingsPage) => void }) {
  return (
    <div className="flex items-center gap-0.5 bg-white/[0.05] p-0.5 rounded-full" role="tablist">
      {PAGES.map((p) => (
        <button key={p.key} type="button" role="tab" aria-selected={page === p.key} onClick={() => onChange(p.key)} className={chipCls(page === p.key)}>
          {p.label}
        </button>
      ))}
    </div>
  );
}

interface Props {
  page: SettingsPage;
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  google: GoogleControls;
  onOpen: (url: string) => void;
}

/** Aba Config do painel */
export function SettingsTab({ page, settings, onChange, google, onOpen }: Props) {
  return (
    <div key={page} className="flex-1 min-h-0 flex flex-col gap-1.5 pt-2 overflow-y-auto custom-scrollbar pr-1 text-[11px]">
      {page === 'geral' && <GeneralPage settings={settings} onChange={onChange} />}
      {page === 'ia' && <AIPage settings={settings} onChange={onChange} onOpen={onOpen} />}
      {page === 'contas' && <AccountsPage settings={settings} onChange={onChange} google={google} onOpen={onOpen} />}
      {page === 'sistema' && <SystemPage settings={settings} onChange={onChange} />}
    </div>
  );
}

// ---- Geral ---------------------------------------------------------------------------

function GeneralPage({ settings: s, onChange }: Pick<Props, 'settings' | 'onChange'>) {
  const [beep, setBeep] = useState<(AudioDiagnostics & { played: boolean }) | null>(null);
  const [cursorExt, setCursorExt] = useState<CursorExtensionStatus | null>(null);
  const [extMsg, setExtMsg] = useState('');
  const [installing, setInstalling] = useState(false);
  const [backend, setBackend] = useState('');
  const [savedPos, setSavedPos] = useState(false);
  const silent = s.muted || s.volume <= 0;

  useEffect(() => {
    void tryInvoke<CursorExtensionStatus>('cursor_extension_status').then(setCursorExt);
    void tryInvoke<string>('audio_backend').then((b) => setBackend(b ?? ''));
    void tryInvoke<boolean>('has_saved_position').then((v) => setSavedPos(!!v));
  }, []);

  const recenter = async () => {
    await tryInvoke('reset_window_position');
    setSavedPos(false);
  };

  const installCursorExtension = async () => {
    setInstalling(true);
    try {
      setExtMsg(await invoke<string>('install_cursor_extension'));
    } catch (err) {
      setExtMsg(`Falhou: ${String(err)}`);
    }
    setCursorExt(await tryInvoke<CursorExtensionStatus>('cursor_extension_status'));
    setInstalling(false);
  };

  // Tela inteira funciona direto no Xorg; no GNOME Wayland precisa da extensão
  const wayland = cursorExt?.session === 'gnome-wayland';
  const screenOk = !!cursorExt && (cursorExt.active || !wayland);
  const relogin = wayland && !cursorExt?.active && cursorExt?.installed && cursorExt?.enabled;

  return (
    <>
      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Som</span>
        <button
          type="button"
          aria-label={s.muted ? 'Ativar som' : 'Silenciar'}
          onClick={() => onChange(silent ? { muted: false, volume: s.volume > 0 ? s.volume : 0.55 } : { muted: true })}
          className={silent ? 'text-amber-400' : 'text-slate-300 hover:text-white'}
        >
          {silent ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
        </button>
        <input
          type="range"
          aria-label="Volume dos efeitos"
          min="0"
          max="1"
          step="0.05"
          value={s.volume}
          onChange={(e) => onChange({ volume: Number(e.target.value) })}
          className="flex-1 min-w-0 accent-white"
        />
        <span className={`w-10 text-right tabular-nums ${silent ? 'text-amber-400' : 'text-slate-300'}`}>
          {s.muted ? 'mudo' : `${Math.round(s.volume * 100)}%`}
        </span>
        <button
          type="button"
          onClick={async () => setBeep(await sound.testBeep())}
          title={
            beep
              ? `Bipe 440 Hz ${beep.played ? 'enviado' : 'não tocou'} · motor ${beep.state} · ${beep.sampleRate} Hz · ${beep.channels} canais`
              : 'Bipe de 440 Hz (toca mesmo com o Lumo mudo)'
          }
          className={smallBtn}
        >
          {beep ? (beep.played ? 'Testar ✓' : 'Sem áudio') : 'Testar'}
        </button>
      </div>

      {isTauri() && (
        <div data-anim="item" className={rowCls}>
          <span className={labelCls}>Saída de som</span>
          <div className="flex items-center gap-0.5 bg-white/[0.05] p-0.5 rounded-full">
            {(['system', 'webkit'] as const).map((o) => (
              <button
                key={o}
                type="button"
                onClick={() => onChange({ audioOutput: o })}
                className={chipCls(s.audioOutput === o)}
                title={o === 'system' ? `Toca pelo servidor de som do sistema${backend ? `: ${backend}` : ''}` : 'Web Audio do WebKitGTK (pode ficar mudo)'}
              >
                {o === 'system' ? 'Sistema' : 'WebKit'}
              </button>
            ))}
          </div>
        </div>
      )}

      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Tamanho</span>
        <input
          type="range"
          aria-label="Tamanho do Lumo"
          min={SCALE_MIN}
          max={SCALE_MAX}
          step="0.05"
          value={s.lumoScale}
          onChange={(e) => onChange({ lumoScale: Number(e.target.value) })}
          className="flex-1 min-w-0 accent-white"
        />
        <span className="w-10 text-right tabular-nums text-slate-300">{Math.round(s.lumoScale * 100)}%</span>
      </div>

      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Fixar no topo</span>
        <Toggle label="Fixar no topo" on={s.alwaysOnTop} onToggle={() => onChange({ alwaysOnTop: !s.alwaysOnTop })} />
        <span className="ml-auto flex gap-1">
          {(s.panelExtra.w > 0 || s.panelExtra.h > 0) && (
            <button type="button" onClick={() => onChange({ panelExtra: { w: 0, h: 0 } })} className={smallBtn} title="O painel volta ao tamanho padrão">
              Painel padrão
            </button>
          )}
          {savedPos && (
            <button type="button" onClick={recenter} className={smallBtn} title="Esquece a posição arrastada e volta ao topo central">
              Recentralizar
            </button>
          )}
        </span>
      </div>

      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Olhar</span>
        <div className="flex items-center gap-0.5 bg-white/[0.05] p-0.5 rounded-full">
          {(['lumo', 'screen'] as CursorMode[]).map((m) => (
            <button key={m} type="button" onClick={() => onChange({ cursorMode: m })} className={chipCls(s.cursorMode === m)}>
              {m === 'lumo' ? 'Só Lumo' : 'Tela inteira'}
            </button>
          ))}
        </div>
        {s.cursorMode === 'screen' && cursorExt && (
          <span
            className={`w-2 h-2 rounded-full ${screenOk ? 'bg-emerald-400' : 'bg-amber-400'}`}
            title={
              extMsg ||
              (screenOk ? 'Seguindo o cursor na tela inteira' : relogin ? 'Extensão instalada: saia e entre na sessão' : 'No Wayland precisa da extensão do GNOME')
            }
          />
        )}
        {s.cursorMode === 'screen' && wayland && !cursorExt?.active && !relogin && (
          <button type="button" disabled={installing} onClick={installCursorExtension} className={`${smallBtn} ml-auto`}>
            {installing ? '…' : 'Extensão GNOME'}
          </button>
        )}
        {relogin && <span className="ml-auto text-amber-400">reinicie a sessão</span>}
      </div>
    </>
  );
}

// ---- IA -------------------------------------------------------------------------------------

function AIPage({ settings: s, onChange, onOpen }: Pick<Props, 'settings' | 'onChange' | 'onOpen'>) {
  const active = s.provider;
  const preset = presetOf(active);
  const cfg = providerConfig(s, active);
  const [models, setModels] = useState<string[]>([]);
  const [modelsMsg, setModelsMsg] = useState('');
  const [loadingModels, setLoadingModels] = useState(false);
  const listBtn = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setModels([]);
    setModelsMsg('');
  }, [active]);

  const setField = (patch: ProviderConfig) =>
    onChange({ providers: { ...s.providers, [active]: { ...s.providers[active], ...patch } } });

  const fetchModels = async () => {
    setLoadingModels(true);
    setModelsMsg('');
    try {
      const ids = await listModels(s, active);
      setModels(ids);
      setModelsMsg(ids.length ? `${ids.length} modelos — escolha no campo Modelo` : 'Nenhum modelo encontrado');
    } catch (err) {
      setModelsMsg(String(err));
      shake(listBtn.current);
    }
    setLoadingModels(false);
  };

  return (
    <>
      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Provedor</span>
        <select
          aria-label="Provedor de IA"
          title={`${preset.hint} Se ele não responder, o Lumo usa outro disponível.`}
          value={active}
          onChange={(e) => onChange({ provider: e.target.value as ProviderId })}
          className={`${inputCls} lumo-select flex-1`}
        >
          {(['free', 'paid', 'local'] as const).map((g) => (
            <optgroup key={g} label={GROUP_LABEL[g]}>
              {PROVIDERS.filter((p) => p.group === g).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </optgroup>
          ))}
        </select>
        {preset.keyUrl && (
          <button type="button" onClick={() => onOpen(preset.keyUrl!)} className={smallBtn} title={preset.keyUrl}>
            Obter chave <ExternalLink className="w-3 h-3" />
          </button>
        )}
      </div>

      {preset.editableBase && (
        <div data-anim="item" className={rowCls}>
          <span className={labelCls}>URL base</span>
          <input
            aria-label="URL base"
            className={`${inputCls} flex-1`}
            value={s.providers[active]?.endpoint ?? (active === 'ollama' ? cfg.endpoint : '')}
            placeholder={preset.baseUrl || 'https://…/v1'}
            onChange={(e) => setField({ endpoint: e.target.value })}
          />
        </div>
      )}

      {active !== 'ollama' && (
        <div data-anim="item" className={rowCls}>
          <span className={labelCls}>Chave</span>
          <input
            type="password"
            aria-label="Chave de API"
            className={`${inputCls} flex-1`}
            value={s.providers[active]?.apiKey ?? ''}
            placeholder={preset.keyless ? 'opcional' : preset.keyPlaceholder ?? 'chave da API'}
            onChange={(e) => setField({ apiKey: e.target.value })}
          />
        </div>
      )}

      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Modelo</span>
        <input
          aria-label="Modelo"
          list="lumo-models"
          className={`${inputCls} flex-1 font-mono`}
          value={s.providers[active]?.model ?? ''}
          placeholder={preset.defaultModel || 'id do modelo'}
          onChange={(e) => setField({ model: e.target.value })}
        />
        <datalist id="lumo-models">
          {models.map((m) => (
            <option key={m} value={m} />
          ))}
        </datalist>
        {(preset.kind === 'openai' || preset.kind === 'ollama') && (
          <button ref={listBtn} type="button" disabled={loadingModels || !cfg.endpoint} onClick={fetchModels} className={smallBtn}>
            {loadingModels ? '…' : 'Listar'}
          </button>
        )}
      </div>
      {modelsMsg && (
        <p className={`${hintCls} pl-[84px] truncate`} title={modelsMsg}>
          {modelsMsg}
        </p>
      )}

      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Comandos</span>
        <Toggle label="Executar comandos sem perguntar" on={s.agentAuto} onToggle={() => onChange({ agentAuto: !s.agentAuto })} />
        <span className="text-slate-300">{s.agentAuto ? 'executa sem perguntar (sudo sempre pergunta)' : 'pergunta antes de executar'}</span>
      </div>
    </>
  );
}

// ---- Contas (Google) ------------------------------------------------------------------------

const GOOGLE_CONSOLE = 'https://console.cloud.google.com/apis/credentials';
const GMAIL_API = 'https://console.cloud.google.com/apis/library/gmail.googleapis.com';

function AccountsPage({ settings: s, onChange, google, onOpen }: Pick<Props, 'settings' | 'onChange' | 'google' | 'onOpen'>) {
  const g = google.status;
  const [editing, setEditing] = useState(false);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const formRef = useRef<HTMLFormElement | null>(null);
  const showForm = editing || (g !== null && !g.configured);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!(await google.configure(clientId, secret))) {
      shake(formRef.current);
      return;
    }
    setEditing(false);
    setSecret('');
  };

  if (!isTauri()) return <p className="text-slate-500">Disponível no app instalado.</p>;

  return (
    <>
      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Google</span>
        <span className={`min-w-0 truncate ${g?.connected ? 'text-slate-200' : 'text-slate-500'}`}>
          {g?.connected ? g.email : g?.configured ? 'não conectado' : 'não configurado'}
        </span>
        <span className="ml-auto flex gap-1">
          {g?.configured && !g.connected && (
            <button type="button" disabled={google.busy} onClick={google.connect} className="lumo-pill shrink-0 px-3 h-6 rounded-full text-white font-semibold disabled:opacity-50">
              {google.busy ? 'Aguardando o navegador…' : 'Conectar'}
            </button>
          )}
          {g?.connected && (
            <button type="button" disabled={google.busy} onClick={google.disconnect} className={smallBtn}>
              {google.busy ? '…' : 'Desconectar'}
            </button>
          )}
          {g?.configured && !g.connected && !editing && g.source === 'app' && (
            <button type="button" onClick={() => setEditing(true)} className={smallBtn}>
              Trocar ID
            </button>
          )}
        </span>
      </div>
      {google.error && (
        <p className="text-[10px] text-amber-400 pl-[84px] line-clamp-2" title={google.error}>
          {google.error}
        </p>
      )}
      {google.busy && !g?.connected && (
        <p className={`${hintCls} pl-[84px]`}>Termine o login na aba que abriu no navegador (até 3 min).</p>
      )}

      {g?.connected && (
        <>
          <div data-anim="item" className={rowCls}>
            <span className={labelCls}>Notificar</span>
            <Toggle label="Notificação do sistema para e-mail novo" on={s.mailNotify} onToggle={() => onChange({ mailNotify: !s.mailNotify })} />
          </div>
          <div data-anim="item" className={rowCls}>
            <span className={labelCls}>Checar a cada</span>
            <div className="flex items-center gap-0.5 bg-white/[0.05] p-0.5 rounded-full">
              {[1, 2, 5, 15].map((m) => (
                <button key={m} type="button" onClick={() => onChange({ mailInterval: m })} className={chipCls(s.mailInterval === m)}>
                  {m} min
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {showForm && (
        <form ref={formRef} onSubmit={save} data-anim="item" className="mt-1 p-2 rounded-xl bg-surface-2 border border-white/5 space-y-1.5">
          <p className={hintCls}>
            Uma vez só: no Google Cloud crie um projeto, ative a{' '}
            <button type="button" onClick={() => onOpen(GMAIL_API)} className="underline text-slate-300 hover:text-white">
              API do Gmail
            </button>{' '}
            (e a do Drive, se quiser), e em{' '}
            <button type="button" onClick={() => onOpen(GOOGLE_CONSOLE)} className="underline text-slate-300 hover:text-white">
              Credenciais
            </button>{' '}
            crie um “ID do cliente OAuth” do tipo <b className="text-slate-300">App para computador</b>. Na tela de consentimento,
            adicione seu e-mail como usuário de teste.
          </p>
          <div className="flex gap-1.5">
            <input
              aria-label="Client ID"
              placeholder="Client ID (….apps.googleusercontent.com)"
              value={clientId}
              onChange={(e) => setClientId(e.target.value)}
              className={`${inputCls} flex-1 font-mono`}
            />
            <input
              type="password"
              aria-label="Client secret"
              placeholder="Client secret"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              className={`${inputCls} w-28 font-mono`}
            />
            <button type="submit" disabled={!clientId.trim() || google.busy} className="lumo-pill shrink-0 px-3 h-6 rounded-full text-white font-semibold disabled:opacity-40">
              Salvar
            </button>
            {editing && (
              <button type="button" onClick={() => setEditing(false)} className={smallBtn}>
                Cancelar
              </button>
            )}
          </div>
        </form>
      )}

    </>
  );
}

// ---- Sistema ---------------------------------------------------------------------------------

function SystemPage({ settings: s, onChange }: Pick<Props, 'settings' | 'onChange'>) {
  const [autostart, setAutostart] = useState<boolean | null>(null);
  const [autostartError, setAutostartError] = useState('');
  const [shortcut, setShortcut] = useState<ShortcutStatus | null>(null);
  const [shortcutError, setShortcutError] = useState('');
  const [info, setInfo] = useState<{ distro: string; kernel: string; desktop: string; session: string } | null>(null);

  useEffect(() => {
    void tryInvoke<boolean>('get_autostart').then(setAutostart);
    void tryInvoke<ShortcutStatus>('shortcut_status').then(setShortcut);
    void tryInvoke<typeof info>('system_info').then(setInfo);
  }, []);

  // O erro aparece por alguns segundos e some (não fica preso no lugar)
  useEffect(() => {
    if (!autostartError && !shortcutError) return;
    const id = window.setTimeout(() => {
      setAutostartError('');
      setShortcutError('');
    }, 8000);
    return () => window.clearTimeout(id);
  }, [autostartError, shortcutError]);

  const toggleAutostart = async () => {
    setAutostartError('');
    try {
      setAutostart(await invoke<boolean>('set_autostart', { enabled: !autostart }));
    } catch (err) {
      setAutostartError(String(err));
      setAutostart(await tryInvoke<boolean>('get_autostart'));
    }
  };

  const toggleShortcut = async () => {
    setShortcutError('');
    try {
      setShortcut(await invoke<ShortcutStatus>('set_shortcut', { enabled: !shortcut?.installed }));
    } catch (err) {
      setShortcutError(String(err));
    }
  };

  if (!isTauri()) return <p className="text-slate-500">Disponível no app instalado.</p>;

  return (
    <>
      {autostart !== null && (
        <div data-anim="item" className={rowCls}>
          <span className={labelCls}>Iniciar com o sistema</span>
          <Toggle label="Iniciar com o sistema" on={autostart} onToggle={toggleAutostart} />
          {autostartError && (
            <span className="text-[10px] text-amber-400 line-clamp-2" title={autostartError}>
              {autostartError}
            </span>
          )}
        </div>
      )}

      <div data-anim="item" className={rowCls}>
        <span className={labelCls}>Atalho</span>
        <kbd className="px-1.5 h-5 leading-5 rounded-md bg-white/10 text-slate-200 font-sans">Ctrl+Alt+L</kbd>
        {shortcut?.gnome && <Toggle label="Atalho ativo em qualquer app (GNOME)" on={shortcut.installed} onToggle={toggleShortcut} />}
      </div>
      {shortcutError && <p className="text-[10px] text-amber-400 pl-[84px]">{shortcutError}</p>}

      <div data-anim="item" className={rowCls}>
        <span className={labelCls} title="RAM, disco, temperatura e bateria no limite">Alertas</span>
        <Toggle label="Alertas do sistema" on={s.systemAlerts} onToggle={() => onChange({ systemAlerts: !s.systemAlerts })} />
      </div>

    </>
  );
}
