import { useEffect, type RefObject } from 'react';

export function isAdminShortcutEvent(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.repeat || event.isComposing || event.altKey) return false;
  return !(
    event.target instanceof Element &&
    event.target.closest(
      'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="combobox"]'
    )
  );
}

export function useAdminSaveShortcut(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!isAdminShortcutEvent(event) || !(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 's') return;
      const root = ref.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-admin-settings-editor]') !== root) return;
      if (document.querySelector('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      const save = root.querySelector<HTMLButtonElement>('button[data-admin-save]');
      if (!save) return;
      event.preventDefault();
      if (!save.disabled) save.click();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [ref]);
}

export function focusAdminSearch(root: HTMLElement): boolean {
  const search = Array.from(root.querySelectorAll<HTMLInputElement>('input[data-admin-search]')).find(input => {
    if (input.disabled) return false;
    for (let node: HTMLElement | null = input; node; node = node.parentElement) {
      if (
        node.hidden ||
        node.getAttribute('aria-hidden') === 'true' ||
        getComputedStyle(node).display === 'none' ||
        getComputedStyle(node).visibility === 'hidden'
      )
        return false;
      if (node === root) break;
    }
    return true;
  });
  search?.focus();
  return !!search;
}
