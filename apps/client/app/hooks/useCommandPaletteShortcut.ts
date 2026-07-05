import { useEffect } from 'react';
import { useCommandPalette } from './useCommandPalette';

/**
 * Global keyboard shortcut handler for the Command Palette.
 * Listens for Cmd+K (Mac) / Ctrl+K (Windows/Linux) when the user
 * is not focused on an editable element.
 */
export function useCommandPaletteShortcut() {
  const toggle = useCommandPalette(s => s.toggle);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'k') return;

      const target = event.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();
      const isEditable =
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target.isContentEditable ||
        target.getAttribute('role') === 'textbox';

      if (isEditable) return;

      event.preventDefault();
      toggle();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [toggle]);
}

export default useCommandPaletteShortcut;
