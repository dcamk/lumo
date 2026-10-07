// Lumo 3D do celular/tablet, no visual realista do PC: vidro escuro e polido com reflexo
// do ambiente e olhos de LED. Quatro formas (cubo, orbe, cristal, gota) com o mesmo rosto.
// Animações sutis:
//   • toque: um leve afundar e voltar;   • dois toques: uma volta lenta;
//   • segurar: os olhos acendem mais;   • arrastar: gira com o dedo e volta com mola;
//   • inclinar o aparelho: acompanha com o olhar;   • sacudir: balança e se recompõe;
//   • parado um tempo: os olhos baixam a luz (descanso).
// Humor vindo de fora (chat): pensando, falando, contente, desanimado.
import { useEffect, useRef } from 'react';
import { mix, type Palette } from '../../../src/theme/palettes';
import { motion } from '../lib/motionBus';

export type ModelId = 'cubo' | 'orbe' | 'cristal' | 'gota';
export type Mood = 'idle' | 'thinking' | 'talking' | 'happy' | 'sad';

export const MODELS: { id: ModelId; name: string }[] = [
  { id: 'cubo', name: 'Cubo' },
  { id: 'orbe', name: 'Orbe' },
  { id: 'cristal', name: 'Cristal' },
  { id: 'gota', name: 'Gota' },
];

export const isModelId = (v: unknown): v is ModelId => MODELS.some((m) => m.id === v);

/** Reação disparada de fora (ex.: resposta chegou). `n` muda a cada disparo. */
export interface Poke {
  kind: 'hop' | 'spin' | 'joy' | 'nod';
  n: number;
}

interface Props {
  model: ModelId;
  palette: Palette;
  mood?: Mood;
  poke?: Poke | null;
  /** Aceita toque/arraste (desligue em telas de descanso) */
  interactive?: boolean;
  /** Segue a inclinação do aparelho */
  tilt?: boolean;
  /** Brilho geral (modo descanso usa menos) */
  dim?: number;
  className?: string;
}

type ThreeNS = typeof import('three');

interface Spring {
  x: number;
  v: number;
}
const spring = (x = 0): Spring => ({ x, v: 0 });
/** Mola amortecida: k = rigidez, c = amortecimento */
function step(s: Spring, target: number, dt: number, k = 120, c = 12) {
  s.v += (target - s.x) * k * dt;
  s.v *= Math.exp(-c * dt);
  s.x += s.v * dt;
}

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);

interface Live {
  model: ModelId;
  palette: Palette;
  mood: Mood;
  tilt: boolean;
  interactive: boolean;
  dim: number;
}

interface Rig {
  setModel: (m: ModelId) => void;
  setPalette: (p: Palette) => void;
  poke: (kind: Poke['kind']) => void;
  dispose: () => void;
}

async function createRig(host: HTMLElement, live: { current: Live }): Promise<Rig> {
  const THREE: ThreeNS = await import('three');
  const { RoundedBoxGeometry } = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environment = envTex;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.05, 5);

  // Luz de estúdio: principal suave, recorte colorido atrás e preenchimento baixo
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  key.position.set(2.5, 3.5, 4);
  const rim = new THREE.PointLight(0xffffff, 22, 12, 2);
  rim.position.set(-2.6, 1.2, -2);
  const fill = new THREE.PointLight(0xffffff, 6, 12, 2);
  fill.position.set(-2, -1.4, 2.6);
  scene.add(key, rim, fill, new THREE.AmbientLight(0xffffff, 0.08));

  // Sombra de contato
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const sctx = shadowCanvas.getContext('2d')!;
  const grad = sctx.createRadialGradient(64, 64, 2, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.45)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 0.5), shadowMat);
  shadow.position.set(0, -1.08, 0);
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);

  // root: posição · spinner: giro e arraste · squash: respiração/afundar · corpo e rosto
  const root = new THREE.Group();
  const spinner = new THREE.Group();
  const squash = new THREE.Group();
  root.add(spinner);
  spinner.add(squash);
  scene.add(root);

  const bodyMat = new THREE.MeshPhysicalMaterial({ metalness: 0.1, roughness: 0.05, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 2.2 });
  const accentMat = new THREE.MeshPhysicalMaterial({ metalness: 0.9, roughness: 0.18, envMapIntensity: 1.6 });
  const eyeMat = new THREE.MeshBasicMaterial({ toneMapped: false });
  const haloMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, depthWrite: false, toneMapped: false });
  const ledMat = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false });
  const eyeBase = new THREE.Color();

  // Rosto: comum a todos os modelos
  const face = new THREE.Group();
  const eyeGeo = new THREE.CapsuleGeometry(0.07, 0.26, 6, 16);
  const eyes: import('three').Mesh[] = [];
  const halos: import('three').Mesh[] = [];
  for (const side of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(side * 0.2, 0.1, 0);
    const h = new THREE.Mesh(eyeGeo, haloMat);
    h.scale.set(1.9, 1.35, 1);
    h.position.z = -0.012;
    e.add(h);
    face.add(e);
    eyes.push(e);
    halos.push(h);
  }
  const mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.014, 0.3, 4, 12), ledMat);
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.27, 0);
  face.add(mouth);
  squash.add(face);

  // ---- modelos -------------------------------------------------------------------------------
  let body: import('three').Object3D | null = null;
  let extra: import('three').Object3D | null = null;
  let blob: { geo: import('three').BufferGeometry; base: Float32Array } | null = null;

  function disposeTree(o: import('three').Object3D) {
    o.traverse((c) => (c as import('three').Mesh).geometry?.dispose());
  }

  function buildModel(id: ModelId) {
    if (body) {
      squash.remove(body);
      disposeTree(body);
    }
    if (extra) {
      spinner.remove(extra);
      disposeTree(extra);
    }
    body = extra = null;
    blob = null;
    bodyMat.flatShading = false;
    switch (id) {
      case 'cubo':
        body = new THREE.Mesh(new RoundedBoxGeometry(1.35, 1.35, 0.95, 10, 0.42), bodyMat);
        face.position.z = 0.48;
        break;
      case 'orbe': {
        body = new THREE.Mesh(new THREE.SphereGeometry(0.78, 64, 48), bodyMat);
        face.position.z = 0.73;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.016, 12, 128), accentMat);
        ring.rotation.set(Math.PI / 2.25, 0, 0.22);
        extra = ring;
        break;
      }
      case 'cristal': {
        bodyMat.flatShading = true;
        body = new THREE.Mesh(new THREE.IcosahedronGeometry(0.88, 0), bodyMat);
        face.position.z = 0.79;
        break;
      }
      case 'gota': {
        const g = new THREE.IcosahedronGeometry(0.8, 14);
        blob = { geo: g, base: Float32Array.from(g.attributes.position.array as ArrayLike<number>) };
        body = new THREE.Mesh(g, bodyMat);
        face.position.z = 0.78;
        break;
      }
    }
    bodyMat.needsUpdate = true;
    if (body) squash.add(body);
    if (extra) spinner.add(extra);
  }

  // ---- partículas: poeira fina em órbita, que acompanha a rolagem --------------------------
  const COUNT = 46;
  const pos = new Float32Array(COUNT * 3);
  const seed = Array.from({ length: COUNT }, () => ({ r: 1.25 + Math.random() * 1.0, a: Math.random() * Math.PI * 2, y: (Math.random() - 0.5) * 2, s: 0.25 + Math.random() * 0.6 }));
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pMat = new THREE.PointsMaterial({ size: 0.026, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);

  function setPalette(p: Palette) {
    const c = p.colors;
    // Realista: vidro escuro e polido (igual ao modo realista do PC)
    bodyMat.color.set(mix(c.bodyBottom, '#05070a', 0.55));
    bodyMat.sheen = 0.25;
    bodyMat.sheenColor = new THREE.Color(c.accent);
    accentMat.color.set(c.accent3);
    // LEDs claros sobre o vidro escuro
    eyeBase.set(mix(c.accent3, '#ffffff', 0.45));
    eyeMat.color.copy(eyeBase);
    haloMat.color.set(c.accent);
    haloMat.opacity = 0.1 + p.character.eyeGlow * 0.2;
    ledMat.color.set(c.accent3);
    pMat.color.set(c.accent3);
    rim.color.set(c.accent);
  }

  // ---- estado animado -----------------------------------------------------------------------
  const sq = spring(1);
  const lift = spring(0);
  const yaw = spring(0);
  const pitch = spring(0);
  const roll = spring(0);
  const lookX = spring(0);
  const lookY = spring(0);
  const eyeOpen = spring(1);
  const glow = spring(1);
  const content = spring(0); // 0–1: olhar contente
  let spin: { from: number; t: number } | null = null;
  let spinBase = 0;
  let boostUntil = 0;
  let blinkAt = performance.now() + 3000;
  let blinkUntil = 0;
  let lastInput = performance.now();
  let dragYaw = 0;
  let dragPitch = 0;
  let dragging = false;
  let held = false;
  let pointerX = 0;
  let pointerY = 0;
  let pointerActive = 0;
  const reduced = reducedMotion();

  function poke(kind: Poke['kind']) {
    lastInput = performance.now();
    if (reduced) return;
    switch (kind) {
      case 'hop':
        sq.v -= 0.9;
        lift.v += 0.9;
        break;
      case 'spin':
        if (!spin) spin = { from: spinBase, t: 0 };
        break;
      case 'joy':
        glow.v += 3;
        lift.v += 0.6;
        content.v += 3;
        boostUntil = performance.now() + 1200;
        break;
      case 'nod':
        pitch.v += 1.6;
        break;
    }
  }

  // ---- toque ---------------------------------------------------------------------------------
  const el = renderer.domElement;
  let downAt = 0;
  let downX = 0;
  let downY = 0;
  let lastX = 0;
  let lastY = 0;
  let lastTap = 0;
  let holdTimer = 0;

  function onDown(e: PointerEvent) {
    if (!live.current.interactive) return;
    el.setPointerCapture(e.pointerId);
    downAt = performance.now();
    downX = lastX = e.clientX;
    downY = lastY = e.clientY;
    dragging = false;
    held = false;
    lastInput = downAt;
    void askTiltPermission();
    holdTimer = window.setTimeout(() => {
      if (!dragging) held = true;
    }, 450);
  }
  function onMove(e: PointerEvent) {
    const r = el.getBoundingClientRect();
    pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointerY = ((e.clientY - r.top) / r.height) * 2 - 1;
    pointerActive = performance.now();
    if (!downAt) return;
    if (Math.hypot(e.clientX - downX, e.clientY - downY) > 10) {
      dragging = true;
      clearTimeout(holdTimer);
    }
    if (dragging) {
      dragYaw += (e.clientX - lastX) * 0.01;
      dragPitch = Math.max(-0.6, Math.min(0.6, dragPitch + (e.clientY - lastY) * 0.006));
      yaw.x = dragYaw;
      pitch.x = dragPitch;
      yaw.v = (e.clientX - lastX) * 0.5;
    }
    lastX = e.clientX;
    lastY = e.clientY;
  }
  function onUp() {
    clearTimeout(holdTimer);
    const quick = performance.now() - downAt < 300;
    if (downAt && !dragging && !held && quick) {
      const now = performance.now();
      if (now - lastTap < 320) {
        lastTap = 0;
        poke('spin');
      } else {
        lastTap = now;
        poke('hop');
      }
    }
    if (dragging) {
      dragYaw = 0;
      dragPitch = 0;
    }
    held = false;
    downAt = 0;
    dragging = false;
  }
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);

  // ---- sensores ------------------------------------------------------------------------------
  let tiltAsked = false;
  async function askTiltPermission() {
    if (tiltAsked) return;
    tiltAsked = true;
    const DOE = (window as unknown as { DeviceOrientationEvent?: { requestPermission?: () => Promise<string> } }).DeviceOrientationEvent;
    try {
      await DOE?.requestPermission?.(); // iPhone pede permissão num toque
    } catch {
      /* negado: segue sem inclinação */
    }
  }
  let lastShake = 0;
  function onMotion(e: DeviceMotionEvent) {
    const a = e.accelerationIncludingGravity ?? e.acceleration;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const now = performance.now();
    if (Math.hypot(a.x, a.y, a.z) > 28 && now - lastShake > 1500) {
      lastShake = now;
      lastInput = now;
      roll.v += 2.4; // balança uma vez e se recompõe
    }
  }
  window.addEventListener('devicemotion', onMotion);

  // ---- tamanho -------------------------------------------------------------------------------
  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Painéis estreitos: afasta a câmera para caber
    camera.position.z = Math.min(10, 5 * Math.max(1, 0.9 / (w / h)));
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  buildModel(live.current.model);
  setPalette(live.current.palette);

  // ---- laço ----------------------------------------------------------------------------------
  let raf = 0;
  let last = performance.now();
  let t = 0;
  const frame = () => {
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    t += dt;
    const { mood, dim } = live.current;
    const resting = now - lastInput > 60_000 && mood === 'idle';
    const busy = mood === 'thinking' || now < boostUntil;
    const calm = reduced ? 0.25 : 1;

    // Flutuar e respirar, devagar
    const float = Math.sin(t * 0.9) * 0.045 * calm;
    step(lift, 0, dt, 70, 9);
    root.position.y = float + lift.x * 0.3 + (mood === 'sad' ? -0.05 : 0);
    step(sq, 1, dt, 180, 14);
    const breathe = 1 + Math.sin(t * 1.4) * 0.008 * calm;
    const s = Math.max(0.9, Math.min(1.08, sq.x)) * breathe;
    squash.scale.set(1 / Math.sqrt(s), s, 1 / Math.sqrt(s));

    // Volta lenta (dois toques), com aceleração e frenagem suaves
    if (spin) {
      spin.t = Math.min(1, spin.t + dt / 1.6);
      spinBase = spin.from + easeInOut(spin.t) * Math.PI * 2;
      if (spin.t >= 1) {
        spinBase = 0;
        spin = null;
      }
    }
    if (!dragging) {
      step(yaw, dragYaw, dt, 30, 7);
      step(pitch, dragPitch + (mood === 'sad' ? 0.08 : 0), dt, 30, 7);
    }
    step(roll, 0, dt, 40, 4);
    spinner.rotation.set(pitch.x * 0.5, yaw.x + spinBase, roll.x * 0.12);

    // Olhar: dedo > inclinação > humor > passeio lento
    let tx = Math.sin(t * 0.23) * 0.2;
    let ty = Math.sin(t * 0.17) * 0.08;
    if (mood === 'thinking') {
      tx = 0.3 + Math.sin(t * 0.8) * 0.06;
      ty = -0.35;
    }
    if (live.current.tilt && (motion.tiltX || motion.tiltY)) {
      tx = motion.tiltX;
      ty = motion.tiltY;
    }
    if (now - pointerActive < 2500) {
      tx = pointerX;
      ty = pointerY;
    }
    step(lookX, tx, dt, 30, 8);
    step(lookY, ty, dt, 30, 8);
    face.rotation.set(lookY.x * 0.3, lookX.x * 0.42, 0);
    face.position.x = lookX.x * 0.06;
    face.position.y = -lookY.x * 0.045;
    if (body && live.current.model !== 'cubo') body.rotation.set(lookY.x * 0.1, lookX.x * 0.14, 0);

    // Piscar, descanso, contentamento
    if (now > blinkAt) {
      blinkUntil = now + 110;
      blinkAt = now + 3000 + Math.random() * 4000;
    }
    step(eyeOpen, now < blinkUntil ? 0.1 : resting ? 0.45 : 1, dt, 320, 22);
    step(content, mood === 'happy' ? 1 : 0, dt, 25, 8);
    const happy = Math.max(0, Math.min(1, content.x));
    for (const [i, e] of eyes.entries()) {
      const open = eyeOpen.x * (1 - happy * 0.25) * (mood === 'sad' ? 0.75 : 1);
      e.scale.set(1, Math.max(0.08, open), 1);
      e.rotation.z = (i === 0 ? 1 : -1) * (happy * 0.12 - (mood === 'sad' ? 0.14 : 0));
    }
    // Brilho dos olhos: segurar acende, descanso e humor baixo apagam um pouco
    step(glow, (held ? 1.6 : resting ? 0.55 : mood === 'sad' ? 0.7 : 1) * dim, dt, 40, 9);
    eyeMat.color.copy(eyeBase).multiplyScalar(Math.max(0.2, glow.x));
    for (const h of halos) h.scale.set(1.9 + (glow.x - 1) * 0.6, 1.35 + (glow.x - 1) * 0.3, 1);

    // Boca de LED: fina; pulsa de leve ao falar
    let mouthW = 0.7 + happy * 0.25;
    let mouthOp = 0.4;
    if (mood === 'talking') {
      mouthW = 0.55 + Math.abs(Math.sin(t * 9) * Math.sin(t * 3.7)) * 0.45;
      mouthOp = 0.85;
    } else if (mood === 'thinking') {
      mouthW = 0.45 + (Math.sin(t * 3) * 0.5 + 0.5) * 0.2;
      mouthOp = 0.6;
    } else if (resting) mouthOp = 0.15;
    mouth.scale.set(1, mouthW, 1);
    ledMat.opacity = mouthOp * dim;

    if (extra) extra.rotation.y += dt * (busy ? 0.5 : 0.18) * calm;
    if (blob) {
      const arr = blob.geo.attributes.position.array as Float32Array;
      const amp = 0.018 + Math.min(0.05, Math.abs(1 - sq.x) * 0.4);
      for (let i = 0; i < arr.length; i += 3) {
        const x = blob.base[i];
        const y = blob.base[i + 1];
        const z = blob.base[i + 2];
        const n = Math.sin(x * 3.2 + t * 1.2 * calm) * Math.sin(y * 3.8 + t * 0.9 * calm) * Math.sin(z * 3.4 + t);
        const k = 1 + n * amp * (z > 0.55 ? 0.25 : 1);
        arr[i] = x * k;
        arr[i + 1] = y * k;
        arr[i + 2] = z * k;
      }
      blob.geo.attributes.position.needsUpdate = true;
      blob.geo.computeVertexNormals();
    }

    // Poeira: órbita lenta; rolar a página ou arrastar empurra junto
    const push = Math.max(-3, Math.min(3, motion.vy * 0.04 + motion.vx * 0.03));
    for (let i = 0; i < COUNT; i++) {
      const p = seed[i];
      p.a += dt * p.s * (busy ? 0.6 : 0.18) * calm + push * dt * p.s;
      p.y -= motion.vy * 0.0015 * p.s;
      if (p.y > 1.1) p.y -= 2.2;
      if (p.y < -1.1) p.y += 2.2;
      pos[i * 3] = Math.cos(p.a) * p.r;
      pos[i * 3 + 1] = p.y + Math.sin(t * 0.5 * p.s + i) * 0.05;
      pos[i * 3 + 2] = Math.sin(p.a) * p.r - 0.4;
    }
    pGeo.attributes.position.needsUpdate = true;
    pMat.opacity = (resting ? 0.2 : busy ? 0.75 : 0.45) * dim;

    shadow.scale.setScalar(1 - root.position.y * 0.35);
    shadowMat.opacity = Math.max(0.25, 1 - root.position.y * 0.7) * dim;

    renderer.render(scene, camera);
  };

  const onVis = () => {
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVis);
  raf = requestAnimationFrame(frame);

  return {
    setModel: buildModel,
    setPalette,
    poke,
    dispose() {
      cancelAnimationFrame(raf);
      clearTimeout(holdTimer);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('devicemotion', onMotion);
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      if (body) disposeTree(body);
      if (extra) disposeTree(extra);
      disposeTree(face);
      pGeo.dispose();
      shadowTex.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      el.remove();
    },
  };
}

function webglOk() {
  try {
    const c = document.createElement('canvas');
    return !!(c.getContext('webgl2') || c.getContext('webgl'));
  } catch {
    return false;
  }
}

export function LumoStage({ model, palette, mood = 'idle', poke, interactive = true, tilt = true, dim = 1, className }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const rig = useRef<Rig | null>(null);
  const live = useRef<Live>({ model, palette, mood, tilt, interactive, dim });
  live.current = { model, palette, mood, tilt, interactive, dim };

  useEffect(() => {
    if (!host.current || !webglOk()) return;
    let cancelled = false;
    void createRig(host.current, live).then((r) => {
      if (cancelled) r.dispose();
      else rig.current = r;
    });
    return () => {
      cancelled = true;
      rig.current?.dispose();
      rig.current = null;
    };
  }, []);

  useEffect(() => rig.current?.setModel(model), [model]);
  useEffect(() => rig.current?.setPalette(palette), [palette]);
  useEffect(() => {
    if (poke) rig.current?.poke(poke.kind);
  }, [poke]);

  return (
    <div ref={host} className={className} aria-label="Lumo em 3D" role="img">
      {!webglOk() && <div className="grid h-full place-items-center text-sm text-muted">Sem WebGL neste aparelho.</div>}
    </div>
  );
}
