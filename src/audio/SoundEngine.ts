/**
 * Sintetizador procedural do Lumo (Web Audio API).
 *
 * Duas saídas:
 *  - 'system' (padrão no app): cada som é sintetizado num OfflineAudioContext (não toca
 *    nada no WebKit), vira WAV uma vez e o Rust toca pelo PipeWire/PulseAudio
 *    (src-tauri/src/audio.rs). Não depende do AudioContext do WebKitGTK, que às vezes
 *    fica "suspended" ou sai no dispositivo errado.
 *  - 'webkit': Web Audio direto, com um `master` de volume/mute. Se o contexto estiver
 *    suspenso, o som espera o `resume()` por até 1,5 s em vez de ser descartado.
 */
import { CUES, STYLE_GAIN, type Cue, type Voice } from './cues';
import type { VoiceStyle } from '../theme/palettes';

export type AudioOutput = 'system' | 'webkit';

const OFFLINE_RATE = 44100;
/** Duração máxima renderizada por som (o silêncio do fim é cortado) */
const OFFLINE_SECONDS = 2.2;

function tauriInvoke(): ((c: string, a?: unknown) => Promise<unknown>) | null {
  const t = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a?: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  return t?.invoke ?? null;
}

/** AudioBuffer mono → WAV 16 bits em base64 (cortando o silêncio do fim) */
function toWavBase64(buffer: AudioBuffer): string {
  const data = buffer.getChannelData(0);
  let end = data.length;
  while (end > 0 && Math.abs(data[end - 1]) < 1e-4) end--;
  end = Math.min(data.length, end + Math.round(buffer.sampleRate * 0.02));
  const bytes = new ArrayBuffer(44 + end * 2);
  const v = new DataView(bytes);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + end * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, buffer.sampleRate, true);
  v.setUint32(28, buffer.sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, end * 2, true);
  for (let i = 0; i < end; i++) v.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i])) * 0x7fff, true);
  let bin = '';
  const u8 = new Uint8Array(bytes);
  for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
  return btoa(bin);
}

export interface AudioDiagnostics {
  state: string;
  sampleRate: number;
  channels: number;
  baseLatency: number;
  muted: boolean;
  volume: number;
}

/** Diagnóstico vai para o console E para o terminal / lumo.log (o console do WebView não aparece no app instalado) */
function audioLog(message: string) {
  console.log(`[Lumo/áudio] ${message}`);
  const t = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (c: string, a: unknown) => Promise<unknown> } })
    .__TAURI_INTERNALS__;
  t?.invoke?.('frontend_log', { message: `áudio: ${message}` }).catch(() => {});
}

/** Quantos sons logar em detalhe (o suficiente para diagnosticar sem poluir o log) */
const VERBOSE_PLAYS = 12;

class SoundEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private muted = false;
  private volume = 0.55;
  private plays = 0;
  private output: AudioOutput = 'system';
  /** Sons já enviados ao Rust (nome → WAV pronto) */
  private sent = new Set<string>();
  private rendering = new Map<string, Promise<string | null>>();

  public setOutput(output: AudioOutput) {
    this.output = output;
  }

  /** A saída do sistema só existe no app nativo */
  private native() {
    return this.output === 'system' && tauriInvoke() !== null && typeof OfflineAudioContext !== 'undefined';
  }

  /** Sintetiza o som uma vez (sem tocar) e devolve o WAV em base64 */
  private render(voice: Voice, name: string): Promise<string | null> {
    let p = this.rendering.get(name);
    if (!p) {
      p = (async () => {
        try {
          const octx = new OfflineAudioContext(1, Math.round(OFFLINE_RATE * OFFLINE_SECONDS), OFFLINE_RATE);
          voice(octx, octx.destination, 0.005);
          return toWavBase64(await octx.startRendering());
        } catch (err) {
          audioLog(`não consegui sintetizar ${name}: ${String(err)}`);
          return null;
        }
      })();
      this.rendering.set(name, p);
    }
    return p;
  }

  /** Toca pelo PipeWire/PulseAudio (Rust). false = não deu, use o WebKit */
  private async playNative(voice: Voice, name: string, volume: number): Promise<boolean> {
    const invoke = tauriInvoke();
    if (!invoke) return false;
    try {
      if (this.sent.has(name)) {
        if (await invoke('play_sound', { name, wav: null, volume })) return true;
      }
      const wav = await this.render(voice, name);
      if (!wav) return false;
      const ok = await invoke('play_sound', { name, wav, volume });
      if (ok) this.sent.add(name);
      return Boolean(ok);
    } catch (err) {
      audioLog(`saída do sistema falhou (${name}): ${String(err)} — usando o WebKit`);
      return false;
    }
  }

  private context(): AudioContext | null {
    if (typeof window === 'undefined') return null;
    if (!this.ctx) {
      const Ctor =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch (err) {
        console.warn('[Lumo] AudioContext indisponível:', err);
        return null;
      }
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.applyGain();
      const ctx = this.ctx;
      audioLog(`contexto criado: ${this.describe()}`);
      ctx.addEventListener('statechange', () => audioLog(`estado → ${ctx.state}`));
    }
    return this.ctx;
  }

  private applyGain() {
    if (!this.master || !this.ctx) return;
    this.master.gain.setTargetAtTime(this.muted ? 0 : this.volume, this.ctx.currentTime, 0.01);
  }

  private async running(): Promise<AudioContext | null> {
    const ctx = this.context();
    if (!ctx) return null;
    if (ctx.state === 'running') return ctx;
    try {
      await Promise.race([ctx.resume(), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* ignore */
    }
    return (ctx.state as AudioContextState) === 'running' ? ctx : null; // o estado muda após o await
  }

  private describe(): string {
    const d = this.diagnostics();
    return `state=${d.state} sampleRate=${d.sampleRate} canais=${d.channels} latência=${d.baseLatency.toFixed(3)}s volume=${d.volume} mudo=${d.muted}`;
  }

  public diagnostics(): AudioDiagnostics {
    const ctx = this.ctx;
    return {
      state: ctx?.state ?? 'não iniciado',
      sampleRate: ctx?.sampleRate ?? 0,
      channels: ctx?.destination.channelCount ?? 0,
      baseLatency: ctx?.baseLatency ?? 0,
      muted: this.muted,
      volume: this.volume,
    };
  }

  private play(voice: Voice, name = 'som') {
    const verbose = this.plays++ < VERBOSE_PLAYS;
    if (this.muted || this.volume <= 0) {
      if (verbose) audioLog(`${name} ignorado: mudo=${this.muted} volume=${this.volume}`);
      return;
    }
    if (this.native()) {
      void this.playNative(voice, name, this.volume).then((ok) => {
        if (verbose) audioLog(`${name} ${ok ? 'tocado pelo sistema' : 'NÃO tocou pelo sistema'}`);
        if (!ok) this.playWebKit(voice, name, verbose);
      });
      return;
    }
    this.playWebKit(voice, name, verbose);
  }

  private playWebKit(voice: Voice, name: string, verbose: boolean) {
    void this.running().then((ctx) => {
      if (!ctx || !this.master) {
        audioLog(`${name} NÃO tocou: contexto ${this.ctx?.state ?? 'inexistente'} (resume não concluiu)`);
        return;
      }
      voice(ctx, this.master, ctx.currentTime + 0.005);
      if (verbose) audioLog(`${name} agendado em t=${ctx.currentTime.toFixed(3)} (${this.describe()})`);
    });
  }

  /**
   * Bipe de teste: 440 Hz por 0,3 s em volume alto fixo, direto na saída
   * (ignora o volume/mudo internos de propósito). Devolve o diagnóstico.
   */
  public async testBeep(): Promise<AudioDiagnostics & { played: boolean }> {
    const beep: Voice = (ctx, out, t) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(440, t);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.8, t + 0.01);
      g.gain.setValueAtTime(0.8, t + 0.28);
      g.gain.linearRampToValueAtTime(0.0001, t + 0.3);
      osc.connect(g);
      g.connect(out);
      osc.start(t);
      osc.stop(t + 0.32);
    };
    if (this.native()) {
      const played = await this.playNative(beep, 'teste-440', 1);
      audioLog(`teste 440 Hz pela saída do sistema: ${played ? 'enviado' : 'falhou'}`);
      if (played) return { ...this.diagnostics(), state: 'sistema', played };
    }
    await this.unlock();
    const ctx = await this.running();
    if (!ctx) {
      audioLog(`teste: contexto não está running (${this.describe()})`);
      return { ...this.diagnostics(), played: false };
    }
    const t = ctx.currentTime + 0.01;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.8, t + 0.01);
    g.gain.setValueAtTime(0.8, t + 0.28);
    g.gain.linearRampToValueAtTime(0.0001, t + 0.3);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.32);
    audioLog(`teste 440 Hz agendado em t=${t.toFixed(3)} (${this.describe()})`);
    return { ...this.diagnostics(), played: true };
  }

  /** Chamar dentro de gestos do usuário. Idempotente. */
  public async unlock() {
    const ctx = this.context();
    if (!ctx) return;
    if (ctx.state !== 'running') {
      // "Kick" inaudível: alguns WebKits só liberam depois de tocar algo num gesto
      try {
        const src = ctx.createBufferSource();
        src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate || 22050);
        src.connect(ctx.destination);
        src.start(0);
      } catch {
        /* ignore */
      }
      await ctx.resume().catch(() => undefined);
    }
  }

  public setMuted(muted: boolean) {
    this.muted = muted;
    this.applyGain();
  }

  public setVolume(vol: number) {
    this.volume = Math.max(0, Math.min(1, vol));
    this.applyGain();
  }

  // ---- sons (estilos em src/audio/cues.ts) ----------------------------------------------

  /** Estilo de voz ativo (a paleta escolhe o padrão; Estilo → Sons permite trocar) */
  private style: VoiceStyle = 'discreto';

  public setStyle(style: VoiceStyle) {
    this.style = style;
  }

  /** Toca um cue no estilo atual; cada variação é sintetizada uma vez e sorteada depois */
  private cue(name: Cue) {
    const style = this.style;
    const def = CUES[style][name];
    const boost = STYLE_GAIN[style];
    const voice: Voice =
      boost === 1
        ? def.voice
        : (ctx, out, t) => {
            const g = ctx.createGain();
            g.gain.setValueAtTime(boost, t);
            g.connect(out);
            def.voice(ctx, g, t);
          };
    this.play(voice, `${style}-${name}-${Math.floor(Math.random() * def.n)}`);
  }

  /** Clique / toque (o som mais frequente — discreto) */
  public playPop() { this.cue('pop'); }
  /** Deu certo / chegou algo */
  public playChirp() { this.cue('chirp'); }
  /** Pensando / trabalhando */
  public playPurr() { this.cue('purr'); }
  /** Alerta / lembrete */
  public playAlert() { this.cue('alert'); }
  /** Adormecer */
  public playSigh() { this.cue('sigh'); }
  /** Irritado */
  public playAngry() { this.cue('angry'); }
  /** Curioso */
  public playCurious() { this.cue('curious'); }
  /** Pulinho */
  public playHop() { this.cue('hop'); }
  /** Carinho */
  public playLove() { this.cue('love'); }
  /** Tontura */
  public playDizzy() { this.cue('dizzy'); }
  /** Acordar */
  public playWake() { this.cue('wake'); }
  /** Bocejo */
  public playYawn() { this.cue('yawn'); }
  /** Esperando o arquivo */
  public playEager() { this.cue('eager'); }
  /** Arquivo recebido */
  public playGulp() { this.cue('gulp'); }
}

export const sound = new SoundEngine();
