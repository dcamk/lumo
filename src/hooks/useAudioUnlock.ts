import { useEffect } from 'react';
import { sound } from '../audio/SoundEngine';

/**
 * Destrava o áudio no primeiro gesto e em todos os seguintes:
 * o WebKit pode suspender o AudioContext de novo quando a janela perde o foco.
 */
export function useAudioUnlock() {
  useEffect(() => {
    void sound.unlock();
    const unlock = () => void sound.unlock();
    window.addEventListener('pointerdown', unlock, { capture: true, passive: true });
    window.addEventListener('keydown', unlock, { capture: true, passive: true });
    window.addEventListener('focus', unlock);
    return () => {
      window.removeEventListener('pointerdown', unlock, true);
      window.removeEventListener('keydown', unlock, true);
      window.removeEventListener('focus', unlock);
    };
  }, []);
}
