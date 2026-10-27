import { useEffect, useRef } from 'react';

export type ProfileShortcutHandlers = Partial<Record<string, () => void>>;

const isTypingTarget = (target: EventTarget | null): boolean => {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
};

// A closed keepMounted Joy Drawer keeps its role="dialog" content in the DOM under an aria-hidden root.
const isDialogOpen = (): boolean =>
  Array.from(document.querySelectorAll('[role="dialog"]')).some(dialog => !dialog.closest('[aria-hidden="true"]'));

/**
 * Single-key shortcuts for a detail page (DESIGN_GUIDE.md section 7: `c` adjusts credits, `s`
 * suspends). Ignored while typing, with a modifier held, or while a dialog is open, so a key never
 * fires behind a modal or steals a character from a field.
 */
export const useProfileShortcuts = (handlers: ProfileShortcutHandlers, enabled = true) => {
  const handlersRef = useRef(handlers);
  useEffect(() => {
    handlersRef.current = handlers;
  });

  useEffect(() => {
    if (!enabled) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;
      if (isDialogOpen()) return;
      const handler = handlersRef.current[event.key.toLowerCase()];
      if (!handler) return;
      event.preventDefault();
      handler();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
};
