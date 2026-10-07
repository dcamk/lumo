// Preferências do app móvel (só neste aparelho)
import { useCallback, useState } from 'react';
import { DEFAULT_PALETTE, isPaletteId, type PaletteId } from '../../../src/theme/palettes';
import { isModelId, type ModelId } from '../three/LumoStage';
import { systemMode, type ColorMode } from './theme';

export interface Prefs {
  model: ModelId;
  palette: PaletteId;
  /** Lumo segue a inclinação do aparelho */
  tilt: boolean;
  /** Vibra nos toques e avisos (Android) */
  haptics: boolean;
  mode: ColorMode;
  /** Entra no modo sempre ligado sozinho ao começar a carregar */
  standbyOnCharge: boolean;
}

const KEY = 'lumo.mobile.prefs';
const DEFAULTS: Prefs = { model: 'cubo', palette: DEFAULT_PALETTE, tilt: true, haptics: true, mode: 'escuro', standbyOnCharge: false };

export function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      model: isModelId(raw.model) ? raw.model : DEFAULTS.model,
      palette: isPaletteId(raw.palette) ? raw.palette : DEFAULTS.palette,
      tilt: typeof raw.tilt === 'boolean' ? raw.tilt : DEFAULTS.tilt,
      haptics: typeof raw.haptics === 'boolean' ? raw.haptics : DEFAULTS.haptics,
      mode: raw.mode === 'claro' || raw.mode === 'escuro' ? raw.mode : systemMode(),
      standbyOnCharge: raw.standbyOnCharge === true,
    };
  } catch {
    return DEFAULTS;
  }
}

export function usePrefs() {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const patch = useCallback((p: Partial<Prefs>) => {
    setPrefs((prev) => {
      const next = { ...prev, ...p };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        /* modo privado */
      }
      return next;
    });
  }, []);
  return [prefs, patch] as const;
}
