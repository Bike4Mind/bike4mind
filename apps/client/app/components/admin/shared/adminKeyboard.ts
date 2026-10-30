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

// Modifier chords cannot collide with typing, so unlike single-key shortcuts they also run from inputs.
export function isAdminChordEvent(event: KeyboardEvent): boolean {
  return (
    !event.defaultPrevented && !event.repeat && !event.isComposing && !event.altKey && (event.metaKey || event.ctrlKey)
  );
}

// A closed keepMounted Joy Drawer keeps its role="dialog" content in the DOM under an aria-hidden root.
export function isAdminOverlayOpen(): boolean {
  return Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"]')).some(
    overlay => !overlay.closest('[aria-hidden="true"]')
  );
}

export function useAdminSaveShortcut(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!isAdminChordEvent(event) || event.key.toLowerCase() !== 's') return;
      const root = ref.current;
      if (!root || !(event.target instanceof Node) || !root.contains(event.target)) return;
      if (event.target instanceof Element && event.target.closest('[data-admin-settings-editor]') !== root) return;
      if (isAdminOverlayOpen()) return;
      // Claim the key even with no Save button rendered (a clean sub-setting) so the browser's Save Page stays out.
      event.preventDefault();
      const save = root.querySelector<HTMLButtonElement>('button[data-admin-save]');
      if (save && !save.disabled) save.click();
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
