// Ponte mínima com o Tauri 2. Fora do app nativo (navegador comum) vira no-op.

type TauriGlobal = { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> };

function tauriGlobal(): TauriGlobal | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { __TAURI_INTERNALS__?: TauriGlobal; __TAURI__?: TauriGlobal };
  const t = w.__TAURI_INTERNALS__ ?? w.__TAURI__;
  return t && typeof t.invoke === 'function' ? t : null;
}

export const isTauri = () => tauriGlobal() !== null;

/** Chama um comando Rust. Lança o erro devolvido pelo comando. */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  const t = tauriGlobal();
  if (!t?.invoke) throw new Error('Tauri indisponível');
  return (await t.invoke(cmd, args)) as T;
}

/** Igual a `invoke`, mas engole erros e devolve null (para chamadas opcionais). */
export async function tryInvoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<T>(cmd, args);
  } catch (err) {
    console.warn(`[Lumo] ${cmd} falhou:`, err);
    return null;
  }
}

/** Escuta um evento emitido pelo Rust. Devolve a função para parar de escutar. */
export async function listen<T>(event: string, handler: (payload: T) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen: tauriListen } = await import('@tauri-apps/api/event');
  return tauriListen<T>(event, (e) => handler(e.payload));
}
