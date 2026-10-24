/**
 * A card or a run of cards is selected/expanded: a pointer on the blank page (or Escape) clears it,
 * a pointer on the card or on an interactive control does not. Shared so every card surface in the
 * editor behaves the same way.
 */
import * as React from 'react';

const INTERACTIVE = 'button, a, input, textarea, select, label, [role="button"], [role="option"], [role="menuitem"], [role="tab"]';

export function useDismissOutside(active: boolean, close: () => void, keepSelector: string, { ignoreControls = true }: { ignoreControls?: boolean } = {}) {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  React.useEffect(() => {
    if (!active) return undefined;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(keepSelector)) return;
      /* A control outside the card is not blank space: pressing it must not first clear the
         selection and move or disable the control under the pointer. An expanded card that
         covers the page is different: any press outside it (a dialog included) collapses it. */
      if (ignoreControls && target.closest(INTERACTIVE)) return;
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
  }, [active, keepSelector, ignoreControls]);
}
