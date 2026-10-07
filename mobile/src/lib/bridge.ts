// Cliente da Ponte Lumo (src-tauri/src/bridge.rs): o celular fala com o Lumo do PC pela
// rede local. Aberto pelo próprio PC (http://<ip>:4646) o endereço já é a origem da
// página; no app nativo ou em desenvolvimento o usuário digita o endereço.

const KEY = 'lumo.mobile.link';

export interface Link {
  /** http://192.168.0.10:4646 */
  base: string;
  token: string;
  /** Nome do PC */
  pc: string;
}

export function loadLink(): Link | null {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Link | null;
    return raw?.base && raw.token ? raw : null;
  } catch {
    return null;
  }
}

export function saveLink(link: Link | null) {
  try {
    if (link) localStorage.setItem(KEY, JSON.stringify(link));
    else localStorage.removeItem(KEY);
  } catch {
    /* modo privado: o pareamento vale só nesta aba */
  }
}

/** Endereço padrão: a própria origem quando a página veio da ponte */
export function defaultBase(): string {
  const { protocol, host, port } = window.location;
  if ((protocol === 'http:' || protocol === 'https:') && port && port !== '1420' && port !== '5173') return `${protocol}//${host}`;
  return '';
}

/** "192.168.0.10" → "http://192.168.0.10:4646" */
export function normalizeBase(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = `http://${s}`;
  try {
    const u = new URL(s);
    if (!u.port) u.port = '4646';
    return `${u.protocol}//${u.host}`;
  } catch {
    return '';
  }
}

export class BridgeError extends Error {
  constructor(
    message: string,
    public status: number
  ) {
    super(message);
  }
}

function deviceName(): string {
  const ua = navigator.userAgent;
  if (/iPad/i.test(ua)) return 'iPad';
  if (/iPhone/i.test(ua)) return 'iPhone';
  const android = ua.match(/Android[^;]*;\s*([^;)]+?)(?:\sBuild|\))/i);
  if (android?.[1]) return android[1].trim();
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? 'Celular Android' : 'Tablet Android';
  return 'Navegador';
}

async function readError(res: Response): Promise<string> {
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return data.error || `HTTP ${res.status}`;
}

export async function hello(base: string): Promise<{ name: string; version: string }> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 5000);
  try {
    const res = await fetch(`${base}/api/hello`, { signal: ctl.signal });
    if (!res.ok) throw new BridgeError(await readError(res), res.status);
    return res.json();
  } catch (err) {
    if (err instanceof BridgeError) throw err;
    throw new BridgeError('Não encontrei o Lumo nesse endereço. O PC e o celular estão na mesma rede?', 0);
  } finally {
    clearTimeout(t);
  }
}

export async function pair(base: string, pin: string): Promise<Link> {
  const info = await hello(base);
  const res = await fetch(`${base}/api/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin: pin.trim(), name: deviceName() }),
  });
  if (!res.ok) throw new BridgeError(await readError(res), res.status);
  const data = (await res.json()) as { token: string };
  return { base, token: data.token, pc: info.name };
}

/** Pedido autenticado. 401 = o PC esqueceu este aparelho (chame onUnauthorized). */
export class Bridge {
  constructor(
    public link: Link,
    private onUnauthorized: () => void
  ) {}

  url(path: string, withToken = false) {
    const u = `${this.link.base}${path}`;
    return withToken ? `${u}${u.includes('?') ? '&' : '?'}t=${encodeURIComponent(this.link.token)}` : u;
  }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url(path), {
        ...init,
        headers: { Authorization: `Bearer ${this.link.token}`, ...(init.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
      });
    } catch {
      throw new BridgeError('Sem conexão com o PC.', 0);
    }
    if (res.status === 401) {
      this.onUnauthorized();
      throw new BridgeError(await readError(res), 401);
    }
    if (!res.ok) throw new BridgeError(await readError(res), res.status);
    return res.json() as Promise<T>;
  }

  get<T>(path: string) {
    return this.request<T>(path);
  }

  post<T>(path: string, body: unknown = {}) {
    return this.request<T>(path, { method: 'POST', body: JSON.stringify(body) });
  }

  /**
   * Conversa com o cérebro do PC. Cada linha da resposta é um evento do agente.
   * Devolve quando a conversa termina; lança se o PC devolver erro.
   */
  async chat(text: string, persona: string | undefined, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    let res: Response;
    try {
      res = await fetch(this.url('/api/chat'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.link.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, persona }),
        signal,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      throw new BridgeError('Sem conexão com o PC.', 0);
    }
    if (res.status === 401) this.onUnauthorized();
    if (!res.ok || !res.body) throw new BridgeError(await readError(res), res.status);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let failure: string | null = null;
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const ev = JSON.parse(line) as AgentEvent | { type: 'end' } | { type: 'error'; text: string };
          if (ev.type === 'end') continue;
          if (ev.type === 'error') failure = (ev as { text: string }).text;
          else onEvent(ev as AgentEvent);
        } catch {
          /* linha quebrada: ignora */
        }
      }
      if (done) break;
    }
    if (failure) throw new BridgeError(failure, 502);
  }

  /** Envia um arquivo para a pasta compartilhada do PC, com progresso (0–1) */
  upload(file: File, onProgress: (p: number) => void): Promise<{ name: string; size: number }> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', this.url('/api/files'));
      xhr.setRequestHeader('Authorization', `Bearer ${this.link.token}`);
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'arquivo'));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        if (xhr.status === 401) this.onUnauthorized();
        let data: { error?: string; name?: string; size?: number } = {};
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          /* sem corpo */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data as { name: string; size: number });
        else reject(new BridgeError(data.error || `HTTP ${xhr.status}`, xhr.status));
      };
      xhr.onerror = () => reject(new BridgeError('A conexão caiu durante o envio.', 0));
      xhr.send(file);
    });
  }

  downloadUrl(name: string) {
    return this.url(`/api/files/${encodeURIComponent(name)}`, true);
  }
}

/** Eventos do agente (src-tauri/src/agent.rs), os mesmos do chat do PC */
export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'text_delta'; text: string }
  | { type: 'command'; id: string; command: string; reason: string; needs_approval: boolean }
  | { type: 'output'; id: string; line: string }
  | { type: 'command_done'; id: string; code: number | null; approved: boolean }
  | { type: 'write'; id: string; path: string; preview: string; needs_approval: boolean }
  | { type: 'write_done'; id: string; approved: boolean; error: string | null }
  | { type: 'read'; path: string }
  | { type: 'notice'; text: string }
  | { type: 'interrupted'; done: string[] };

export interface Stats {
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
  temp: number | null;
  battery: number | null;
  charging: boolean;
  net_down: number;
  net_up: number;
  uptime: number;
  load: number;
  cores: number;
}

export interface Media {
  player: string;
  playing: boolean;
  title: string;
  artist: string;
}

export interface PcStatus {
  name: string;
  version: string;
  stats: Stats;
  media: Media | null;
}

export interface SharedFile {
  name: string;
  size: number;
  modified: number;
}

export const formatBytes = (n: number) =>
  n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;

let hapticsOn = true;
export const setHaptics = (on: boolean) => {
  hapticsOn = on;
};

/** Vibração curta (Android); no iPhone não faz nada */
export const haptic = (ms = 10) => {
  if (!hapticsOn) return;
  try {
    navigator.vibrate?.(ms);
  } catch {
    /* sem vibração */
  }
};
