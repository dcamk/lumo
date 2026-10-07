// Lumo 3D do celular/tablet. Quatro modelos (cubo, orbe, cristal, gota) com o mesmo rosto
// e animações pensadas para toque:
//   • toque: amassa e pula;   • dois toques: gira;   • segurar: fica feliz (faíscas);
//   • arrastar: gira com o dedo e volta com mola;   • inclinar o aparelho: olha junto;
//   • sacudir: fica tonto;   • parado um tempo: cochila.
// Humor vindo de fora (chat): pensando (partículas aceleram, olhar para cima), falando
// (boca de LED pulsa), feliz, triste.
import { useEffect, useRef } from 'react';
import type { Palette } from '../../../src/theme/palettes';

export type ModelId = 'cubo' | 'orbe' | 'cristal' | 'gota';
export type Mood = 'idle' | 'thinking' | 'talking' | 'happy' | 'sad';

export const MODELS: { id: ModelId; name: string; hint: string }[] = [
  { id: 'cubo', name: 'Cubo', hint: 'O Lumo clássico, de vidro e metal' },
  { id: 'orbe', name: 'Orbe', hint: 'Esfera com anel em órbita' },
  { id: 'cristal', name: 'Cristal', hint: 'Facetas que brilham na luz' },
  { id: 'gota', name: 'Gota', hint: 'Gelatina que balança ao toque' },
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
  /** Aceita toque/arraste (desligue em miniaturas) */
  interactive?: boolean;
  /** Segue a inclinação do aparelho */
  tilt?: boolean;
  className?: string;
  onInteract?: (what: 'tap' | 'double' | 'hold' | 'shake') => void;
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

interface Live {
  model: ModelId;
  palette: Palette;
  mood: Mood;
  tilt: boolean;
  interactive: boolean;
  onInteract?: Props['onInteract'];
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
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block;touch-action:none';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.75;

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);
  camera.position.set(0, 0.1, 5);

  const key = new THREE.DirectionalLight(0xffffff, 1.7);
  key.position.set(2, 3, 4);
  const rim = new THREE.PointLight(0xffffff, 18, 12, 2);
  rim.position.set(-2.4, -0.6, -1.5);
  const fill = new THREE.PointLight(0xffffff, 10, 12, 2);
  fill.position.set(-2, -1, 2.4);
  scene.add(key, rim, fill, new THREE.AmbientLight(0xffffff, 0.15));

  // Sombra de contato (disco suave sob o personagem)
  const shadowCanvas = document.createElement('canvas');
  shadowCanvas.width = shadowCanvas.height = 128;
  const sctx = shadowCanvas.getContext('2d')!;
  const grad = sctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  sctx.fillStyle = grad;
  sctx.fillRect(0, 0, 128, 128);
  const shadowTex = new THREE.CanvasTexture(shadowCanvas);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.5), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  shadow.position.set(0, -1.05, 0);
  shadow.rotation.x = -Math.PI / 2;
  scene.add(shadow);

  // root: posição/pulo · spinner: giro e arraste · squash: amassar · body/face
  const root = new THREE.Group();
  const spinner = new THREE.Group();
  const squash = new THREE.Group();
  root.add(spinner);
  spinner.add(squash);
  scene.add(root);

  const bodyMat = new THREE.MeshPhysicalMaterial({ metalness: 0.5, roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.1 });
  const accentMat = new THREE.MeshPhysicalMaterial({ metalness: 0.8, roughness: 0.2, emissiveIntensity: 0.6 });
  const eyeMat = new THREE.MeshBasicMaterial();
  const haloMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, depthWrite: false });
  const ledMat = new THREE.MeshBasicMaterial({ transparent: true });

  // Rosto: comum a todos os modelos (a profundidade muda por modelo)
  const face = new THREE.Group();
  const eyeGeo = new THREE.CapsuleGeometry(0.08, 0.28, 6, 16);
  const eyes: import('three').Mesh[] = [];
  for (const side of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(side * 0.21, 0.1, 0);
    const h = new THREE.Mesh(eyeGeo, haloMat);
    h.scale.set(1.6, 1.25, 1);
    h.position.z = -0.01;
    e.add(h);
    face.add(e);
    eyes.push(e);
  }
  const mouth = new THREE.Mesh(new THREE.CapsuleGeometry(0.025, 0.32, 4, 12), ledMat);
  mouth.rotation.z = Math.PI / 2;
  mouth.position.set(0, -0.26, 0);
  face.add(mouth);
  squash.add(face);

  // ---- modelos -------------------------------------------------------------------------------
  let body: import('three').Object3D | null = null;
  let extra: import('three').Object3D | null = null;
  let blob: { geo: import('three').BufferGeometry; base: Float32Array } | null = null;

  function disposeTree(o: import('three').Object3D) {
    o.traverse((c) => {
      const m = c as import('three').Mesh;
      if (m.geometry) m.geometry.dispose();
    });
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
    bodyMat.transmission = 0;
    bodyMat.roughness = 0.25;
    bodyMat.metalness = 0.5;
    switch (id) {
      case 'cubo':
        body = new THREE.Mesh(new RoundedBoxGeometry(1.35, 1.35, 0.95, 8, 0.42), bodyMat);
        face.position.z = 0.49;
        break;
      case 'orbe': {
        body = new THREE.Mesh(new THREE.SphereGeometry(0.78, 48, 32), bodyMat);
        face.position.z = 0.74;
        const ring = new THREE.Mesh(new THREE.TorusGeometry(1.12, 0.035, 12, 96), accentMat);
        ring.rotation.set(Math.PI / 2.4, 0, 0.3);
        extra = ring;
        break;
      }
      case 'cristal': {
        const g = new THREE.IcosahedronGeometry(0.88, 0);
        bodyMat.flatShading = true;
        bodyMat.roughness = 0.08;
        bodyMat.metalness = 0.15;
        body = new THREE.Mesh(g, bodyMat);
        face.position.z = 0.8;
        // Mini cristais em órbita
        const shards = new THREE.Group();
        for (let i = 0; i < 3; i++) {
          const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.09, 0), accentMat);
          const a = (i / 3) * Math.PI * 2;
          s.position.set(Math.cos(a) * 1.25, Math.sin(a * 2) * 0.25, Math.sin(a) * 1.25);
          shards.add(s);
        }
        extra = shards;
        break;
      }
      case 'gota': {
        const g = new THREE.IcosahedronGeometry(0.8, 12);
        blob = { geo: g, base: Float32Array.from(g.attributes.position.array as ArrayLike<number>) };
        bodyMat.roughness = 0.15;
        body = new THREE.Mesh(g, bodyMat);
        face.position.z = 0.78;
        break;
      }
    }
    bodyMat.needsUpdate = true;
    if (body) squash.add(body);
    if (extra) spinner.add(extra);
  }

  // ---- partículas ---------------------------------------------------------------------------
  const COUNT = 90;
  const pos = new Float32Array(COUNT * 3);
  const seed = Array.from({ length: COUNT }, () => ({ r: 1.2 + Math.random() * 0.9, a: Math.random() * Math.PI * 2, y: (Math.random() - 0.5) * 1.8, s: 0.3 + Math.random() * 0.7 }));
  const burst = Array.from({ length: COUNT }, () => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, life: 0 }));
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pMat = new THREE.PointsMaterial({ size: 0.045, transparent: true, opacity: 0.8, blending: THREE.AdditiveBlending, depthWrite: false });
  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);
  let burstLeft = 0;

  function sparkle(n = 60) {
    burstLeft = 1.4;
    for (let i = 0; i < Math.min(n, COUNT); i++) {
      const b = burst[i];
      const a = Math.random() * Math.PI * 2;
      const up = Math.random() * Math.PI - Math.PI / 2;
      const sp = 1.2 + Math.random() * 1.8;
      b.x = b.y = b.z = 0;
      b.vx = Math.cos(a) * Math.cos(up) * sp;
      b.vy = Math.abs(Math.sin(up)) * sp + 0.6;
      b.vz = Math.sin(a) * Math.cos(up) * sp;
      b.life = 0.8 + Math.random() * 0.6;
    }
  }

  function setPalette(p: Palette) {
    const c = p.colors;
    bodyMat.color.set(c.bodyTop).lerp(new THREE.Color(c.bodyBottom), 0.35);
    bodyMat.sheen = 0.4;
    bodyMat.sheenColor = new THREE.Color(c.bodyEdge);
    accentMat.color.set(c.accent);
    accentMat.emissive = new THREE.Color(c.accent);
    eyeMat.color.set(c.eye);
    haloMat.color.set(c.eye);
    haloMat.opacity = 0.15 + p.character.eyeGlow * 0.35;
    ledMat.color.set(c.accent);
    pMat.color.set(c.accent3);
    rim.color.set(c.accent);
  }

  // ---- estado animado -----------------------------------------------------------------------
  const sq = spring(1); // amassar (1 = normal)
  const hop = spring(0); // altura do pulo
  const yaw = spring(0);
  const pitch = spring(0);
  const lookX = spring(0);
  const lookY = spring(0);
  const eyeOpen = spring(1);
  const joy = spring(0); // 0–1: olhos de "feliz" (arcos)
  let spinLeft = 0;
  let spinAngle = 0;
  let dizzy = 0;
  let blinkAt = performance.now() + 2500;
  let blinkUntil = 0;
  let lastInput = performance.now();
  let dragYaw = 0;
  let dragPitch = 0;
  let dragging = false;
  let tiltX = 0;
  let tiltY = 0;
  let pointerX = 0;
  let pointerY = 0;
  let pointerActive = 0;
  const reduced = reducedMotion();

  function poke(kind: Poke['kind']) {
    lastInput = performance.now();
    if (reduced) {
      if (kind === 'joy') joy.x = 1;
      return;
    }
    switch (kind) {
      case 'hop':
        sq.x = 0.78;
        hop.v = 3.2;
        break;
      case 'spin':
        spinLeft = Math.PI * 2;
        hop.v = 2;
        break;
      case 'joy':
        joy.v = 8;
        sparkle();
        hop.v = 2.2;
        break;
      case 'nod':
        pitch.v = 3;
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
  let tapTimer = 0;
  let held = false;

  const emit = (what: 'tap' | 'double' | 'hold' | 'shake') => live.current.onInteract?.(what);

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
      if (!dragging) {
        held = true;
        poke('joy');
        emit('hold');
      }
    }, 550);
  }
  function onMove(e: PointerEvent) {
    const r = el.getBoundingClientRect();
    pointerX = ((e.clientX - r.left) / r.width) * 2 - 1;
    pointerY = ((e.clientY - r.top) / r.height) * 2 - 1;
    pointerActive = performance.now();
    if (!downAt) return;
    const dist = Math.hypot(e.clientX - downX, e.clientY - downY);
    if (dist > 10) {
      dragging = true;
      clearTimeout(holdTimer);
    }
    if (dragging) {
      dragYaw += (e.clientX - lastX) * 0.012;
      dragPitch = Math.max(-0.8, Math.min(0.8, dragPitch + (e.clientY - lastY) * 0.008));
      yaw.x = dragYaw;
      pitch.x = dragPitch;
      yaw.v = (e.clientX - lastX) * 0.6;
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
        clearTimeout(tapTimer);
        lastTap = 0;
        poke('spin');
        emit('double');
      } else {
        lastTap = now;
        poke('hop');
        tapTimer = window.setTimeout(() => emit('tap'), 330);
      }
    }
    if (dragging) {
      // Solta: volta para a frente (com o embalo do arraste)
      dragYaw = 0;
      dragPitch = 0;
    }
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
  function onOrient(e: DeviceOrientationEvent) {
    if (!live.current.tilt || e.gamma == null || e.beta == null) return;
    tiltX = Math.max(-1, Math.min(1, e.gamma / 35));
    tiltY = Math.max(-1, Math.min(1, (e.beta - 45) / 35));
  }
  let lastShake = 0;
  function onMotion(e: DeviceMotionEvent) {
    const a = e.accelerationIncludingGravity ?? e.acceleration;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    const g = Math.hypot(a.x, a.y, a.z);
    const now = performance.now();
    if (g > 28 && now - lastShake > 1500) {
      lastShake = now;
      dizzy = 2.2;
      lastInput = now;
      emit('shake');
    }
  }
  window.addEventListener('deviceorientation', onOrient);
  window.addEventListener('devicemotion', onMotion);

  // ---- tamanho -------------------------------------------------------------------------------
  const resize = () => {
    const w = host.clientWidth || 1;
    const h = host.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // Telas estreitas (celular em pé): afasta a câmera para caber
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
    const { mood } = live.current;
    const sleepy = now - lastInput > 60_000 && mood === 'idle';
    const speed = (reduced ? 0.3 : 1) * (mood === 'thinking' ? 2.6 : sleepy ? 0.4 : 1);

    // Flutuar e respirar
    const float = reduced ? 0 : Math.sin(t * 1.3 * (sleepy ? 0.5 : 1)) * 0.07;
    step(hop, 0, dt, 60, 4);
    if (hop.x < 0) {
      hop.x = 0;
      if (hop.v < -1) sq.x = Math.min(sq.x, 0.88); // aterrissa e amassa
      hop.v = Math.abs(hop.v) * 0.25;
    }
    root.position.y = float + hop.x * 0.35 + (mood === 'sad' ? -0.08 : 0);
    const breathe = 1 + Math.sin(t * 2.1) * (sleepy ? 0.025 : 0.012);
    step(sq, 1, dt, 260, 10);
    const sy = sq.x * breathe;
    const sxz = 1 / Math.sqrt(Math.max(0.5, sq.x));
    squash.scale.set(sxz, sy, sxz);

    // Giro (dois toques) e arraste
    if (spinLeft > 0) {
      const d = Math.min(spinLeft, dt * 11 * Math.max(0.25, spinLeft / (Math.PI * 2)));
      spinLeft -= d;
      spinAngle += d;
    } else spinAngle = 0;
    if (!dragging) {
      step(yaw, dragYaw, dt, 40, 6);
      step(pitch, dragPitch, dt, 40, 6);
    }
    // Tontura: balança em Z, decaindo
    dizzy = Math.max(0, dizzy - dt);
    const wobble = dizzy > 0 ? Math.sin(t * 18) * 0.25 * (dizzy / 2.2) : 0;
    spinner.rotation.set(pitch.x * 0.6, yaw.x + spinAngle, wobble + (mood === 'sad' ? 0.06 : 0));

    // Olhar: dedo > inclinação > humor > passeio sozinho
    let tx = Math.sin(t * 0.35) * 0.25;
    let ty = Math.sin(t * 0.21) * 0.1;
    if (mood === 'thinking') {
      tx = 0.35 + Math.sin(t * 2) * 0.1;
      ty = -0.45;
    }
    if (live.current.tilt && (tiltX || tiltY)) {
      tx = tiltX;
      ty = tiltY;
    }
    if (now - pointerActive < 2500) {
      tx = pointerX;
      ty = pointerY;
    }
    step(lookX, tx, dt, 50, 9);
    step(lookY, ty, dt, 50, 9);
    face.rotation.set(lookY.x * 0.35, lookX.x * 0.5, 0);
    face.position.x = lookX.x * 0.08;
    face.position.y = -lookY.x * 0.06;
    if (body && live.current.model !== 'cubo') body.rotation.set(lookY.x * 0.12, lookX.x * 0.18, 0);

    // Piscar, cochilar, olhos felizes
    if (now > blinkAt) {
      blinkUntil = now + 120;
      blinkAt = now + 2000 + Math.random() * 3500;
    }
    const closed = now < blinkUntil || sleepy;
    step(eyeOpen, closed ? 0.08 : 1, dt, 400, 22);
    step(joy, mood === 'happy' ? 1 : 0, dt, 30, 8);
    const happy = Math.max(0, Math.min(1, joy.x));
    for (const [i, e] of eyes.entries()) {
      const open = eyeOpen.x * (1 - happy * 0.6) * (mood === 'sad' ? 0.7 : 1);
      e.scale.set(1 + happy * 0.25, Math.max(0.06, open), 1);
      e.rotation.z = (i === 0 ? 1 : -1) * (happy * 0.35 - (mood === 'sad' ? 0.3 : 0));
      if (dizzy > 0) e.rotation.z += Math.sin(t * 20 + i * Math.PI) * 0.5;
    }

    // Boca de LED: fala = pulsa; pensando = varre; feliz = larga
    let mouthW = 0.7 + happy * 0.5;
    let mouthOp = 0.55;
    if (mood === 'talking') {
      mouthW = 0.5 + Math.abs(Math.sin(t * 13) * Math.sin(t * 5.3)) * 0.9;
      mouthOp = 0.95;
    } else if (mood === 'thinking') {
      mouthW = 0.35 + (Math.sin(t * 6) * 0.5 + 0.5) * 0.4;
      mouthOp = 0.8;
    } else if (sleepy) {
      mouthW = 0.3;
      mouthOp = 0.25;
    }
    mouth.scale.set(1, mouthW, 1);
    ledMat.opacity = mouthOp;

    // Extras do modelo
    if (extra) {
      extra.rotation.y += dt * 0.6 * speed;
      if (live.current.model === 'orbe') extra.rotation.z = 0.3 + Math.sin(t * 0.7) * 0.15;
    }
    if (blob) {
      // Gelatina: ondas na superfície, mais fortes depois de um toque
      const arr = blob.geo.attributes.position.array as Float32Array;
      const amp = 0.03 + Math.min(0.12, Math.abs(1 - sq.x) * 0.6 + Math.abs(hop.v) * 0.015);
      for (let i = 0; i < arr.length; i += 3) {
        const x = blob.base[i];
        const y = blob.base[i + 1];
        const z = blob.base[i + 2];
        const n = Math.sin(x * 4 + t * 2.4 * speed) * Math.sin(y * 5 + t * 1.9 * speed) * Math.sin(z * 4.5 + t * 2.1);
        const k = 1 + n * amp * (z > 0.55 ? 0.3 : 1); // rosto quase parado
        arr[i] = x * k;
        arr[i + 1] = y * k;
        arr[i + 2] = z * k;
      }
      blob.geo.attributes.position.needsUpdate = true;
      blob.geo.computeVertexNormals();
    }

    // Partículas: órbita (mais rápida pensando) ou faíscas da alegria
    burstLeft = Math.max(0, burstLeft - dt);
    for (let i = 0; i < COUNT; i++) {
      const s = seed[i];
      const b = burst[i];
      if (b.life > 0) {
        b.life -= dt;
        b.vy -= 3.2 * dt;
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.z += b.vz * dt;
        pos[i * 3] = b.x;
        pos[i * 3 + 1] = b.y + root.position.y;
        pos[i * 3 + 2] = b.z;
        continue;
      }
      s.a += dt * s.s * 0.4 * speed;
      pos[i * 3] = Math.cos(s.a) * s.r;
      pos[i * 3 + 1] = s.y + Math.sin(t * s.s + i) * 0.08;
      pos[i * 3 + 2] = Math.sin(s.a) * s.r - 0.4;
    }
    pGeo.attributes.position.needsUpdate = true;
    pMat.opacity = sleepy ? 0.25 : mood === 'thinking' ? 1 : 0.7;
    pMat.size = burstLeft > 0 ? 0.07 : 0.045;

    shadow.scale.setScalar(1 - root.position.y * 0.4);
    (shadow.material as import('three').MeshBasicMaterial).opacity = Math.max(0.2, 1 - root.position.y * 0.8);

    renderer.render(scene, camera);
  };

  // Aba escondida: para de desenhar (bateria)
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
      clearTimeout(tapTimer);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('deviceorientation', onOrient);
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

export function LumoStage({ model, palette, mood = 'idle', poke, interactive = true, tilt = true, className, onInteract }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const rig = useRef<Rig | null>(null);
  const live = useRef<Live>({ model, palette, mood, tilt, interactive, onInteract });
  live.current = { model, palette, mood, tilt, interactive, onInteract };

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
    <div ref={host} className={className} aria-label="Lumo em 3D. Toque, segure ou arraste." role="img">
      {!webglOk() && <div className="grid h-full place-items-center text-sm text-muted">Este aparelho não tem WebGL para o Lumo 3D.</div>}
    </div>
  );
}
