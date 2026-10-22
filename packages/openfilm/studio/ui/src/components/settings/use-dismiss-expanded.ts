/**
 * One expanded Settings card at a time: a pointer on the blank page (or Escape) closes it, a pointer
 * inside the open card does not. This is the behaviour people expect from an expanded card; it is
 * shared so provider and agent cards cannot drift apart.
 */
import * as React from 'react';

export function useDismissExpanded(active: boolean, close: () => void, selector: string) {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!active) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(selector)) return;
      /* An interactive control outside the open card is not "blank area": clicking a skill's +,
         a filter or a menu must not first collapse the card and move the control under the pointer. */
      if (target instanceof Element && target.closest('button, a, input, textarea, select, label, [role="button"], [role="option"], [role="menuitem"]')) return;
      closeRef.current();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      closeRef.current();
    };
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, selector]);
}
