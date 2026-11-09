// The QDtech touchscreen reports as a mouse-style pointer, so a finger drag is
// a mouse drag and Chromium won't scroll. This turns drags on any scrollable
// area into scrolling (with a little momentum) and swallows the click that
// would otherwise fire at the end of a drag.
const DRAG_THRESHOLD = 8;

function scrollableParent(el: Element | null): HTMLElement | null {
  for (let n = el as HTMLElement | null; n && n !== document.body; n = n.parentElement) {
    if (n.dataset.noDragScroll !== undefined || n.tagName === "CANVAS" || n.tagName === "INPUT" || n.tagName === "TEXTAREA") return null;
    const s = getComputedStyle(n);
    if ((s.overflowY === "auto" || s.overflowY === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
  }
  return null;
}

export function installDragScroll(): () => void {
  let target: HTMLElement | null = null;
  let startY = 0;
  let startTop = 0;
  let dragging = false;
  let lastY = 0;
  let lastT = 0;
  let velocity = 0;
  let suppressClick = false;
  let raf = 0;

  const down = (e: PointerEvent) => {
    if (e.pointerType === "touch" || e.button !== 0) return; // real touch scrolls natively
    cancelAnimationFrame(raf);
    target = scrollableParent(e.target as Element);
    if (!target) return;
    startY = lastY = e.clientY;
    startTop = target.scrollTop;
    lastT = performance.now();
    velocity = 0;
    dragging = false;
  };
  const move = (e: PointerEvent) => {
    if (!target) return;
    const dy = e.clientY - startY;
    if (!dragging && Math.abs(dy) > DRAG_THRESHOLD) dragging = true;
    if (!dragging) return;
    target.scrollTop = startTop - dy;
    const t = performance.now();
    velocity = 0.8 * velocity + 0.2 * ((lastY - e.clientY) / Math.max(1, t - lastT));
    lastY = e.clientY;
    lastT = t;
    e.preventDefault();
  };
  const up = () => {
    if (!target) return;
    if (dragging) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false), 0);
      const el = target;
      let v = velocity * 16; // px per frame
      const step = () => {
        if (Math.abs(v) < 0.5) return;
        el.scrollTop += v;
        v *= 0.92;
        raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }
    target = null;
    dragging = false;
  };
  const click = (e: MouseEvent) => {
    if (suppressClick) {
      e.preventDefault();
      e.stopPropagation();
      suppressClick = false;
    }
  };

  document.addEventListener("pointerdown", down, true);
  document.addEventListener("pointermove", move, { capture: true, passive: false });
  document.addEventListener("pointerup", up, true);
  document.addEventListener("pointercancel", up, true);
  document.addEventListener("click", click, true);
  return () => {
    document.removeEventListener("pointerdown", down, true);
    document.removeEventListener("pointermove", move, true);
    document.removeEventListener("pointerup", up, true);
    document.removeEventListener("pointercancel", up, true);
    document.removeEventListener("click", click, true);
  };
}
