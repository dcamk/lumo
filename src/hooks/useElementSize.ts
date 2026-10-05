import { useLayoutEffect, useState, type RefObject } from 'react';

/** Tamanho atual de um elemento (acompanha o redimensionamento da janela). */
export function useElementSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    // offsetWidth/Height = tamanho de layout, sem `transform`. (getBoundingClientRect
    // incluiria a escala das animações de entrada e o Lumo nasceria minúsculo.)
    const update = () => {
      const r = { width: el.offsetWidth, height: el.offsetHeight };
      setSize((prev) => (prev.width === r.width && prev.height === r.height ? prev : r));
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);

  return size;
}
