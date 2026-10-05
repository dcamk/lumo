import { useCallback, useEffect, useRef, useState } from 'react';
import type { CharacterEmotion } from '../character/types';

/**
 * Emoção "de fundo" (derivada do estado do app) + reações temporárias.
 * `flash('happy', 2000)` mostra a reação e volta sozinho para a emoção de fundo.
 */
export function useEmotion(base: CharacterEmotion) {
  const [flashed, setFlashed] = useState<CharacterEmotion | null>(null);
  const timerRef = useRef<number | undefined>(undefined);

  const flash = useCallback((emotion: CharacterEmotion, ms = 2000) => {
    window.clearTimeout(timerRef.current);
    setFlashed(emotion);
    timerRef.current = window.setTimeout(() => setFlashed(null), ms);
  }, []);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return [flashed ?? base, flash] as const;
}
