import { useEffect, useRef, useState } from "react";

/** Ширина контейнера через ResizeObserver — для SVG в пиксельных координатах. */
export function useWidth<T extends HTMLElement>(initial = 720): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && Math.abs(cw - w) > 0.5) setW(cw);
    });
    ro.observe(el);
    setW(el.clientWidth || initial);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [ref, w];
}
