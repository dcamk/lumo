// App móvel do Lumo. Celular: abas embaixo. Tablet: barra lateral e, no chat em tela
// larga, o Lumo 3D ao lado da conversa. Respeita notch e barras do sistema (safe-area).
import { Cloud as CloudIcon, Gauge, MessageCircle, Settings2, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PALETTES } from '../../src/theme/palettes';
import { setPalette, usePalette } from '../../src/theme/store';
import { ParticleField } from './components/ParticleField';
import { startMotionBus } from './lib/motionBus';
import { applyTheme } from './lib/theme';
import { usePc } from './hooks/usePc';
import { useRemoteChat } from './hooks/useRemoteChat';
import { Bridge, loadLink, saveLink, setHaptics, type Link } from './lib/bridge';
import { usePrefs } from './lib/prefs';
import { Chat } from './screens/Chat';
import { Connect } from './screens/Connect';
import { Control } from './screens/Control';
import { Cloud } from './screens/Cloud';
import { Home } from './screens/Home';
import { Settings } from './screens/Settings';
import { goFullscreen, Standby } from './screens/Standby';
import { LumoStage, type Mood, type Poke } from './three/LumoStage';

type Tab = 'home' | 'chat' | 'cloud' | 'control' | 'settings';

const TABS: { id: Tab; label: string; icon: typeof Sparkles }[] = [
  { id: 'home', label: 'Lumo', icon: Sparkles },
  { id: 'chat', label: 'Chat', icon: MessageCircle },
  { id: 'cloud', label: 'Nuvem', icon: CloudIcon },
  { id: 'control', label: 'Controle', icon: Gauge },
  { id: 'settings', label: 'Ajustes', icon: Settings2 },
];

function useMedia(query: string) {
  const [on, setOn] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const fn = () => setOn(mq.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, [query]);
  return on;
}

export function App() {
  const [prefs, patch] = usePrefs();
  const palette = usePalette();
  const [link, setLink] = useState<Link | null>(loadLink);
  const [lostReason, setLostReason] = useState('');
  const [tab, setTab] = useState<Tab>('home');
  const [toastMsg, setToastMsg] = useState<{ text: string; n: number } | null>(null);
  const [poke, setPoke] = useState<Poke | null>(null);
  const [afterglow, setAfterglow] = useState<Mood | null>(null);
  const tablet = useMedia('(min-width: 768px)');
  const large = useMedia('(min-width: 1024px)');

  const [standby, setStandby] = useState(false);
  const [dir, setDir] = useState(1);
  useEffect(() => startMotionBus(), []);
  useEffect(() => {
    setPalette(prefs.palette);
    applyTheme(PALETTES[prefs.palette], prefs.mode);
  }, [prefs.palette, prefs.mode]);
  useEffect(() => setHaptics(prefs.haptics), [prefs.haptics]);

  // Sempre ligado ao carregar (Android: API de bateria)
  useEffect(() => {
    if (!prefs.standbyOnCharge) return;
    const nav = navigator as Navigator & { getBattery?: () => Promise<{ charging: boolean; addEventListener: (e: string, f: () => void) => void; removeEventListener: (e: string, f: () => void) => void }> };
    let off = () => {};
    void nav.getBattery?.().then((b) => {
      const fn = () => b.charging && setStandby(true);
      fn();
      b.addEventListener('chargingchange', fn);
      off = () => b.removeEventListener('chargingchange', fn);
    });
    return () => off();
  }, [prefs.standbyOnCharge]);

  const forget = useCallback((reason: string) => {
    saveLink(null);
    setLink(null);
    setLostReason(reason);
  }, []);
  const bridge = useMemo(() => (link ? new Bridge(link, () => forget('Este aparelho foi removido no PC. Pareie de novo.')) : null), [link, forget]);

  const toast = useCallback((text: string) => {
    const n = Date.now();
    setToastMsg({ text, n });
    window.setTimeout(() => setToastMsg((t) => (t?.n === n ? null : t)), 2600);
  }, []);

  const glowTimer = useRef(0);
  const onReply = useCallback((ok: boolean) => {
    setPoke({ kind: ok ? 'joy' : 'nod', n: Date.now() });
    setAfterglow(ok ? 'happy' : 'sad');
    clearTimeout(glowTimer.current);
    glowTimer.current = window.setTimeout(() => setAfterglow(null), 2500);
  }, []);

  const chat = useRemoteChat(bridge, onReply);
  const pc = usePc(bridge, tab === 'control' ? 2500 : 6000);
  const mood: Mood = chat.phase === 'thinking' ? 'thinking' : chat.phase === 'talking' ? 'talking' : (afterglow ?? 'idle');

  // Pedido de aprovação chegando com o usuário em outra aba: avisa
  const pending = chat.items.some((m) => (m.kind === 'command' || m.kind === 'write') && m.status === 'pending');
  useEffect(() => {
    if (pending && tab !== 'chat') toast('O Lumo pediu sua aprovação no Chat.');
  }, [pending, tab, toast]);

  if (!link || !bridge) {
    return (
      <>
        <ParticleField />
        <Connect
          palette={palette}
          model={prefs.model}
          reason={lostReason}
          onLinked={(l) => {
            saveLink(l);
            setLink(l);
            setLostReason('');
            setTab('home');
          }}
        />
      </>
    );
  }

  const go = (t: Tab) => {
    setDir(TABS.findIndex((x) => x.id === t) >= TABS.findIndex((x) => x.id === tab) ? 1 : -1);
    setTab(t);
  };
  const openStandby = () => {
    goFullscreen();
    setStandby(true);
  };

  const screen = (() => {
    switch (tab) {
      case 'home':
        return <Home bridge={bridge} palette={palette} model={prefs.model} mood={mood} poke={poke} tilt={prefs.tilt} status={pc.status} online={pc.online} wide={tablet} go={go} standby={openStandby} toast={toast} />;
      case 'chat': {
        const view = <Chat {...chat} online={pc.online} />;
        if (!large) return view;
        return (
          <div className="flex h-full gap-4 pl-4">
            <div className="m-card relative hidden w-[38%] max-w-md overflow-hidden lg:block">
              <LumoStage model={prefs.model} palette={palette} mood={mood} poke={poke} tilt={prefs.tilt} className="absolute inset-0" />
            </div>
            <div className="min-w-0 flex-1">{view}</div>
          </div>
        );
      }
      case 'cloud':
        return <Cloud bridge={bridge} toast={toast} onSent={() => setPoke({ kind: 'hop', n: Date.now() })} />;
      case 'control':
        return <Control bridge={bridge} status={pc.status} online={pc.online} setMedia={(media) => pc.setStatus((s) => (s ? { ...s, media } : s))} toast={toast} />;
      case 'settings':
        return (
          <Settings
            bridge={bridge}
            prefs={prefs}
            patch={patch}
            onDisconnect={() => {
              void bridge.post('/api/unpair').catch(() => {});
              forget('');
            }}
          />
        );
    }
  })();


  return (
    <div className="relative flex h-full" style={{ paddingLeft: 'var(--safe-left)', paddingRight: 'var(--safe-right)' }}>
      <ParticleField />

      {tablet && (
        <nav className="relative z-10 flex w-24 shrink-0 flex-col items-center gap-2 border-r border-line py-4" style={{ paddingTop: 'calc(var(--safe-top) + 16px)' }} aria-label="Seções">
          <StatusDot online={pc.online} />
          {TABS.map((t) => (
            <NavButton key={t.id} tab={t} active={tab === t.id} badge={t.id === 'chat' && pending} onClick={() => go(t.id)} vertical />
          ))}
        </nav>
      )}

      <div className="relative z-10 flex min-w-0 flex-1 flex-col">
        {!tablet && <div style={{ height: 'calc(var(--safe-top) + 12px)' }} />}

        <main className="relative min-h-0 flex-1" style={tablet ? { paddingTop: 'calc(var(--safe-top) + 12px)' } : undefined}>
          {/* Transição no sentido da aba (direita/esquerda; no tablet, de cima/baixo) */}
          <AnimatePresence mode="popLayout" initial={false} custom={dir}>
            <motion.div
              key={tab}
              className="absolute inset-0"
              custom={dir}
              initial={{ opacity: 0, x: tablet ? 0 : 28 * dir, y: tablet ? 20 * dir : 0, scale: 0.99 }}
              animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
              exit={{ opacity: 0, x: tablet ? 0 : -28 * dir, y: tablet ? -12 * dir : 0, scale: 0.99 }}
              transition={{ duration: 0.38, ease: [0.22, 1, 0.36, 1] }}
            >
              {screen}
            </motion.div>
          </AnimatePresence>
        </main>

        {!tablet && (
          <nav className="relative z-10 grid grid-cols-5 border-t border-line bg-[color-mix(in_srgb,var(--shell)_85%,transparent)] backdrop-blur-xl" style={{ paddingBottom: 'var(--safe-bottom)' }} aria-label="Seções">
            {TABS.map((t) => (
              <NavButton key={t.id} tab={t} active={tab === t.id} badge={t.id === 'chat' && pending} onClick={() => go(t.id)} />
            ))}
          </nav>
        )}
      </div>

      <AnimatePresence>{standby && <Standby palette={palette} model={prefs.model} mood={mood} status={pc.status} online={pc.online} onExit={() => setStandby(false)} />}</AnimatePresence>

      <AnimatePresence>
        {toastMsg && (
          <motion.div
            key={toastMsg.n}
            initial={{ opacity: 0, y: 30, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="m-card fixed left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 px-4 py-3 text-center text-[14px] font-medium shadow-2xl"
            style={{ bottom: `calc(var(--safe-bottom) + ${tablet ? 24 : 84}px)` }}
            role="status"
          >
            {toastMsg.text}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function StatusDot({ online }: { online: boolean }) {
  return (
    <span className="relative flex h-2.5 w-2.5" title={online ? 'Conectado' : 'Sem conexão'}>
      <span className={`relative inline-flex h-2.5 w-2.5 rounded-full ${online ? 'bg-ok' : 'bg-danger'}`} />
    </span>
  );
}

function NavButton({ tab, active, badge, onClick, vertical = false }: { tab: (typeof TABS)[number]; active: boolean; badge: boolean; onClick: () => void; vertical?: boolean }) {
  const Icon = tab.icon;
  return (
    <button type="button" onClick={onClick} aria-current={active ? 'page' : undefined} className={`relative flex flex-col items-center justify-center gap-1 ${vertical ? 'h-16 w-20 rounded-2xl' : 'h-16'}`}>
      {active && <motion.span layoutId={vertical ? 'nav-v' : 'nav-h'} className={`absolute bg-accent/15 ${vertical ? 'inset-0 rounded-2xl' : 'inset-x-2 inset-y-1.5 rounded-2xl'}`} transition={{ type: 'spring', stiffness: 500, damping: 35 }} />}
      <motion.span animate={{ y: active ? -1 : 0, scale: active ? 1.12 : 1 }} transition={{ type: 'spring', stiffness: 500, damping: 20 }} className="relative">
        <Icon className={`h-[22px] w-[22px] ${active ? 'text-accent' : 'text-muted'}`} />
        {badge && <span className="absolute -right-1 -top-1 h-2.5 w-2.5 rounded-full bg-warn" />}
      </motion.span>
      <span className={`relative text-[11px] font-semibold ${active ? 'text-ink' : 'text-muted'}`}>{tab.label}</span>
    </button>
  );
}
