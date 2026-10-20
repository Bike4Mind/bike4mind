import type { KeyboardEvent } from 'react';

/** Enter/Space activation for non-button elements; ignores keys bubbling from nested controls. */
export const activateOnKey =
  (activate: () => void) =>
  (event: KeyboardEvent<HTMLElement>): void => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    activate();
  };
