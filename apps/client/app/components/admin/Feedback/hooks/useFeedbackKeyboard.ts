import { useEffect, type RefObject } from 'react';
import { isAdminShortcutEvent } from '../../shared/adminKeyboard';

type FeedbackKeyboardOptions = {
  rootRef: RefObject<HTMLElement | null>;
  enabled?: boolean;
  drawer?: boolean;
  onPrevious?: () => void;
  onNext?: () => void;
  onAction: (key: 'i' | 'c' | 'e', rowId?: string) => void;
};

export function useFeedbackKeyboard({
  rootRef,
  enabled = true,
  drawer = false,
  onPrevious,
  onNext,
  onAction,
}: FeedbackKeyboardOptions) {
  useEffect(() => {
    if (!enabled) return;
    const handleKey = (event: KeyboardEvent) => {
      if (!isAdminShortcutEvent(event) || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const root = rootRef.current;
      const target = event.target;
      if (!root || !(target instanceof HTMLElement) || !root.contains(target)) return;
      // The drawer itself is allowed, but a resolution dialog, menu or help panel owns its keys.
      const blocked = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]'))
        .filter(overlay => !overlay.closest('[aria-hidden="true"]'))
        .some(overlay => !drawer || !overlay.contains(root));
      if (blocked) return;
      const key = event.key.toLowerCase();
      if (!['j', 'k', 'i', 'c', 'e'].includes(key)) return;
      const rows = Array.from(root.querySelectorAll<HTMLElement>('[data-row-id]'));
      const row = target.closest<HTMLElement>('[data-row-id]');
      if (!drawer && target !== row && target !== root && target.getAttribute('role') !== 'region') return;
      if (key === 'j' || key === 'k') {
        event.preventDefault();
        if (drawer) {
          (key === 'j' ? onNext : onPrevious)?.();
        } else {
          const index = row ? rows.indexOf(row) : key === 'j' ? -1 : rows.length;
          rows[index + (key === 'j' ? 1 : -1)]?.focus();
        }
      } else if (drawer || row) {
        event.preventDefault();
        onAction(key as 'i' | 'c' | 'e', row?.dataset.rowId);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [rootRef, enabled, drawer, onPrevious, onNext, onAction]);
}
