// Prévia 3D do Lumo (three.js) usada no painel Estilo: corpo de vidro/metal com a cor da
// paleta, olhos de LED e partículas (órbita, ou "chuva" nas paletas terminal). O three.js
// é carregado sob demanda; se o WebGL não estiver disponível, cai para o desenho 2D.
import { useEffect, useRef, useState } from 'react';
import { drawFrame } from '../character/draw';
import type { Palette } from '../theme/palettes';

type ThreeNS = typeof import('three');
type Mesh = import('three').Mesh;

interface Rig {
  setPalette: (p: Palette) => void;
  setRealistic: (on: boolean) => void;
  dispose: () => void;
}

const reduced = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

async function createRig(host: HTMLElement, initial: Palette): Promise<Rig> {
  const THREE: ThreeNS = await import('three');
  const { RoundedBoxGeometry } = await import('three/examples/jsm/geometries/RoundedBoxGeometry.js');
  const { RoomEnvironment } = await import('three/examples/jsm/environments/RoomEnvironment.js');

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.style.cssText = 'width:100%;height:100%;display:block';
  host.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.environmentIntensity = 0.7;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
  camera.position.set(0, 0.05, 4.6);

  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 3, 4);
  const fill = new THREE.PointLight(0xffffff, 14, 12, 2);
  fill.position.set(-2.2, -1, 2.2);
  scene.add(key, fill, new THREE.AmbientLight(0xffffff, 0.15));

  // ---- corpo + rosto ------------------------------------------------------------------------
  const group = new THREE.Group();
  scene.add(group);
  const bodyMat = new THREE.MeshPhysicalMaterial({ metalness: 0.55, roughness: 0.28, clearcoat: 1, clearcoatRoughness: 0.12 });
  const body = new THREE.Mesh(new RoundedBoxGeometry(1.3, 1.3, 0.9, 8, 0.4), bodyMat);
  group.add(body);

  const eyeGeo = new THREE.CapsuleGeometry(0.075, 0.3, 6, 16);
  const eyeMat = new THREE.MeshBasicMaterial();
  const haloMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false });
  const eyes: Mesh[] = [];
  const halos: Mesh[] = [];
  for (const side of [-1, 1]) {
    const e = new THREE.Mesh(eyeGeo, eyeMat);
    e.position.set(side * 0.2, 0.12, 0.46);
    const h = new THREE.Mesh(eyeGeo, haloMat);
    h.position.copy(e.position);
    h.position.z += 0.005;
    h.scale.set(1.55, 1.2, 1.3);
    group.add(e, h);
    eyes.push(e);
    halos.push(h);
  }
  const ledMat = new THREE.MeshBasicMaterial({ transparent: true });
  const led = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.022, 0.02), ledMat);
  led.position.set(0, -0.5, 0.455);
  group.add(led);

  // ---- partículas ---------------------------------------------------------------------------
  const COUNT = 70;
  const base = new Float32Array(COUNT * 3);
  const pos = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    const r = 1.15 + Math.random() * 0.9;
    const a = Math.random() * Math.PI * 2;
    base[i * 3] = Math.cos(a) * r;
    base[i * 3 + 1] = (Math.random() - 0.5) * 2.6;
    base[i * 3 + 2] = Math.sin(a) * r * 0.6;
  }
  pos.set(base);
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const pMat = new THREE.PointsMaterial({ size: 0.035, transparent: true, opacity: 0.7, depthWrite: false });
  const points = new THREE.Points(pGeo, pMat);
  scene.add(points);

  // ---- estado animado ----------------------------------------------------------------------
  const cur = {
    body: new THREE.Color(),
    eye: new THREE.Color(),
    led: new THREE.Color(),
    dots: new THREE.Color(),
    key: new THREE.Color(),
    fill: new THREE.Color(),
  };
  const tgt = { body: new THREE.Color(), eye: new THREE.Color(), led: new THREE.Color(), dots: new THREE.Color(), fill: new THREE.Color() };
  let pal = initial;
  let glow = initial.character.eyeGlow;
  let curGlow = glow;
  let rain = initial.character.particles === 'glyphs';
  let snap = true;

  const setPalette = (p: Palette) => {
    pal = p;
    const c = p.colors;
    tgt.body.set(c.bodyTop).lerp(new THREE.Color(c.bodyBottom), 0.45);
    tgt.eye.set(c.eye);
    tgt.led.set(c.accent);
    tgt.dots.set(p.character.particles === 'glyphs' ? c.accent : c.accent3);
    tgt.fill.set(c.accent);
    glow = p.character.eyeGlow;
    rain = p.character.particles === 'glyphs';
    // paletas escuras: corpo mais "vidro", paletas claras: mais metal
    bodyMat.metalness = p.darkness > 3 ? 0.25 : 0.55;
    bodyMat.roughness = p.darkness > 3 ? 0.18 : 0.3;
    // realista: vidro escuro e polido, com reflexo forte do ambiente
    if (realistic) {
      bodyMat.metalness = 0.1;
      bodyMat.roughness = 0.04;
      bodyMat.envMapIntensity = 2.2;
      tgt.body.set(c.bodyBottom).lerp(new THREE.Color('#05070a'), 0.55);
    } else {
      bodyMat.envMapIntensity = 1;
    }
    bodyMat.needsUpdate = true;
    glitchUntil = performance.now() + (p.motion.glitch > 0.3 ? 500 : 0);
  };
  let glitchUntil = 0;
  let realistic = false;
  const setRealistic = (on: boolean) => {
    realistic = on;
    setPalette(pal);
  };
  setPalette(initial);

  // Ponteiro sobre a prévia: o Lumo olha e vira para o mouse
  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  const onMove = (e: PointerEvent) => {
    const r = host.getBoundingClientRect();
    look.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    look.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  const onLeave = () => {
    look.tx = 0;
    look.ty = 0;
  };
  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerleave', onLeave);

  const resize = () => {
    const w = Math.max(40, host.clientWidth);
    const h = Math.max(40, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };
  const ro = new ResizeObserver(resize);
  ro.observe(host);
  resize();

  let raf = 0;
  let last = performance.now();
  let nextBlink = last + 2500;
  let blink = -1;
  const still = reduced();

  const frame = (now: number) => {
    const dt = Math.min((now - last) / 1000, 0.1);
    last = now;
    const t = now / 1000;
    const k = snap ? 1 : Math.min(1, dt * 7);
    snap = false;

    cur.body.lerp(tgt.body, k);
    cur.eye.lerp(tgt.eye, k);
    cur.led.lerp(tgt.led, k);
    cur.dots.lerp(tgt.dots, k);
    cur.fill.lerp(tgt.fill, k);
    curGlow += (glow - curGlow) * k;
    bodyMat.color.copy(cur.body);
    eyeMat.color.copy(cur.eye);
    haloMat.color.copy(cur.eye);
    haloMat.opacity = 0.14 * curGlow;
    ledMat.color.copy(cur.led);
    ledMat.opacity = curGlow > 0.05 ? 0.55 + Math.sin(t * 3) * 0.15 : 0;
    pMat.color.copy(cur.dots);
    fill.color.copy(cur.fill);

    // movimento: a amplitude vem da personalidade (profissional = contido)
    const m = pal.motion;
    const amp = still ? 0 : 0.35 + m.lift * 1.2;
    look.x += (look.tx - look.x) * Math.min(1, dt * 5);
    look.y += (look.ty - look.y) * Math.min(1, dt * 5);
    group.rotation.y = Math.sin(t * 0.55) * 0.32 * amp + look.x * 0.5;
    group.rotation.x = Math.sin(t * 0.4) * 0.05 * amp + look.y * 0.3;
    group.position.y = Math.sin(t * 1.1) * 0.025 * amp;
    for (const e of eyes) e.position.x = Math.sign(e.position.x) * 0.2 + look.x * 0.03;

    // piscar
    if (now > nextBlink && blink < 0) blink = now;
    let sy = 1;
    if (blink >= 0) {
      const b = (now - blink) / 140;
      sy = b >= 1 ? 1 : Math.max(0.08, 1 - Math.sin(b * Math.PI));
      if (b >= 1) {
        blink = -1;
        nextBlink = now + 2200 + Math.random() * 3000;
      }
    }
    for (const e of eyes) e.scale.y = sy;
    for (const h of halos) h.scale.y = 1.2 * sy;

    // glitch (paletas terminal): tremida horizontal e piscada dos olhos
    const spike = m.glitch > 0 && (now < glitchUntil || (!still && Math.floor(t) % 6 === 0 && t % 1 < 0.1));
    group.position.x = spike ? (Math.random() - 0.5) * 0.12 * (0.4 + m.glitch) : 0;
    eyeMat.visible = !(spike && Math.random() < 0.3);

    // partículas: órbita lenta, ou chuva caindo nas paletas terminal
    const arr = pGeo.attributes.position.array as Float32Array;
    for (let i = 0; i < COUNT; i++) {
      const bx = base[i * 3];
      const bz = base[i * 3 + 2];
      if (rain) {
        let y = arr[i * 3 + 1] - dt * (0.5 + (i % 5) * 0.18);
        if (y < -1.5) y = 1.5;
        arr[i * 3] = bx;
        arr[i * 3 + 1] = y;
        arr[i * 3 + 2] = bz;
      } else if (!still) {
        const a = t * 0.12 * (1 + (i % 3) * 0.3);
        arr[i * 3] = bx * Math.cos(a) - bz * Math.sin(a);
        arr[i * 3 + 1] = base[i * 3 + 1] + Math.sin(t * 0.5 + i) * 0.04;
        arr[i * 3 + 2] = bx * Math.sin(a) + bz * Math.cos(a);
      }
    }
    pGeo.attributes.position.needsUpdate = true;

    renderer.render(scene, camera);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  return {
    setPalette,
    setRealistic,
    dispose: () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      host.removeEventListener('pointermove', onMove);
      host.removeEventListener('pointerleave', onLeave);
      scene.traverse((o) => {
        const mesh = o as Mesh;
        mesh.geometry?.dispose?.();
      });
      [bodyMat, eyeMat, haloMat, ledMat, pMat].forEach((m) => m.dispose());
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

/** Fallback sem WebGL: o mesmo corpo desenhado em 2D */
function Fallback2D({ palette }: { palette: Palette }) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    const ctx = cv?.getContext('2d');
    if (!cv || !ctx) return;
    const S = 120;
    const dpr = window.devicePixelRatio || 1;
    cv.width = S * dpr;
    cv.height = S * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawFrame(ctx, {
      size: S, time: 0, emotion: 'idle', eyeStyle: 'normal', openness: 1, eyeX: 0, eyeY: 0, offsetY: 0,
      rotation: 0, scaleX: 1, scaleY: 1, shakeX: 0, mouth: 0, particles: [], palette, dpr,
    });
  }, [palette]);
  return <canvas ref={ref} style={{ width: '100%', height: '100%', objectFit: 'contain' }} aria-hidden />;
}

export function Lumo3D({ palette, realistic = false, className = '' }: { palette: Palette; realistic?: boolean; className?: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rig = useRef<Rig | null>(null);
  const latest = useRef(palette);
  latest.current = palette;
  const latestReal = useRef(realistic);
  latestReal.current = realistic;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let dead = false;
    createRig(host, latest.current)
      .then((r) => {
        if (dead) r.dispose();
        else {
          rig.current = r;
          r.setRealistic(latestReal.current);
          r.setPalette(latest.current);
        }
      })
      .catch((err) => {
        console.warn('[Lumo] prévia 3D indisponível, usando 2D:', err);
        if (!dead) setFailed(true);
      });
    return () => {
      dead = true;
      rig.current?.dispose();
      rig.current = null;
    };
  }, []);

  useEffect(() => rig.current?.setPalette(palette), [palette]);
  useEffect(() => rig.current?.setRealistic(realistic), [realistic]);

  return (
    <div ref={hostRef} className={className} role="img" aria-label={`Prévia 3D do Lumo na paleta ${palette.name}`}>
      {failed && <Fallback2D palette={palette} />}
    </div>
  );
}
