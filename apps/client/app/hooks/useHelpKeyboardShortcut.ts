import { useEffect } from 'react';
import { useHelpPanel } from './useHelpPanel';

/**
 * Global keyboard shortcut handler for Help Center
 *
 * Listens for the '?' key (Shift + /) when:
 * - User is not focused on an input, textarea, or contenteditable element
 * - No modifier keys are pressed (except Shift for the '?' key)
 *
 * Toggles the Help Center panel open/closed.
 */
export function useHelpKeyboardShortcut() {
  const { open, setOpen } = useHelpPanel();

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if the pressed key is '?' (Shift + /)
      if (event.key !== '?') return;

      // Don't trigger if Ctrl, Alt, or Meta keys are pressed
      if (event.ctrlKey || event.altKey || event.metaKey) return;

      // Don't trigger if focus is on an editable element
      const target = event.target as HTMLElement;
      const tagName = target.tagName.toLowerCase();
      const isEditable =
        tagName === 'input' ||
        tagName === 'textarea' ||
        tagName === 'select' ||
        target.isContentEditable ||
        target.getAttribute('role') === 'textbox';

      if (isEditable) return;

      // Prevent the '?' from being typed in the page
      event.preventDefault();

      setOpen(!open);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, setOpen]);
}

export default useHelpKeyboardShortcut;
