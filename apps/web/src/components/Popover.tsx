import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * A small non-modal popover positioned under an anchor rectangle.
 * It does not close on outside clicks, so typed input is never lost by accident.
 */
export function Popover({ anchor, children, label, width = 380 }: { anchor: DOMRect; children: ReactNode; label: string; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ top: anchor.bottom + 4, left: anchor.left });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top = anchor.bottom + 4;
    if (top + h > vh - 8) top = Math.max(8, anchor.top - h - 4);
    const left = Math.min(Math.max(8, anchor.left), vw - width - 8);
    setPos({ top, left });
  }, [anchor, width]);

  return createPortal(
    <div ref={ref} className="popover" role="dialog" aria-label={label} style={{ top: pos.top, left: pos.left, width }}>
      {children}
    </div>,
    document.body,
  );
}
