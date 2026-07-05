import { useEffect, RefObject } from 'react';

/**
 * Auto-focuses an element when it becomes available (e.g. a chat input, so
 * switching chats lets the user start typing immediately).
 *
 * @param ref - React ref to the element that should be focused
 * @param options - Optional configuration
 * @param options.enabled - Whether auto-focus is enabled (default: true)
 * @param options.focusOnClick - Whether to refocus when clicking outside the element (default: false)
 */
export function useAutoFocus<T extends HTMLElement>(
  ref: RefObject<T>,
  options?: {
    enabled?: boolean;
    focusOnClick?: boolean;
  }
) {
  const { enabled = true, focusOnClick = false } = options || {};

  useEffect(() => {
    if (!enabled) return;

    const focusElement = () => {
      if (ref.current) {
        // Use setTimeout to ensure the element is fully rendered
        setTimeout(() => {
          ref.current?.focus();
        }, 0);
      }
    };

    focusElement();

    // Also try to focus after a short delay in case the element isn't ready yet
    const timeoutId = setTimeout(focusElement, 100);

    return () => {
      clearTimeout(timeoutId);
    };
  }, [ref, enabled]);

  // Optionally refocus when clicking outside the element
  useEffect(() => {
    if (!enabled || !focusOnClick) return;

    const handleClickOutside = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) {
        // Small delay to avoid interfering with other click handlers
        setTimeout(() => {
          ref.current?.focus();
        }, 50);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [ref, enabled, focusOnClick]);
}
