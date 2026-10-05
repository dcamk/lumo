import { useEffect, useState } from 'react';

function read<T>(key: string, fallback: T, migrate?: (raw: Record<string, unknown>) => void): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const parsed = JSON.parse(raw);
    if (migrate && parsed && typeof parsed === 'object') migrate(parsed);
    // Objetos: campos novos ganham o valor padrão e campos que não existem mais
    // (ex.: opções removidas) são descartados
    if (fallback && typeof fallback === 'object' && !Array.isArray(fallback)) {
      const merged = { ...fallback } as Record<string, unknown>;
      for (const k of Object.keys(merged)) if (k in parsed) merged[k] = parsed[k];
      return merged as T;
    }
    return parsed as T;
  } catch {
    return fallback;
  }
}

/** useState que sobrevive a reinícios (localStorage do WebView). */
export function usePersistentState<T>(key: string, fallback: T, migrate?: (raw: Record<string, unknown>) => void) {
  const [value, setValue] = useState<T>(() => read(key, fallback, migrate));

  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* armazenamento indisponível: segue só em memória */
    }
  }, [key, value]);

  return [value, setValue] as const;
}
