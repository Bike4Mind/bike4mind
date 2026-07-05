import { useEffect } from 'react';

/**
 * Repositions the Beautiful Mentions menu above the cursor. The library
 * positions it below via inline styles; a MutationObserver detects when the
 * menu is added/updated in the DOM and flips it above.
 */
export function MentionsMenuPositionPlugin(): null {
  useEffect(() => {
    const repositionMenu = (menu: HTMLElement) => {
      // Wait a bit longer for the plugin to set initial position
      setTimeout(() => {
        requestAnimationFrame(() => {
          const boundingRect = menu.getBoundingClientRect();

          // Get current position - prefer bounding rect as it's what's actually rendered
          const currentVisualTop = boundingRect.top;
          const currentVisualLeft = boundingRect.left;

          // Only reposition if the menu has a valid position (not at 0,0)
          if (currentVisualTop === 0 && currentVisualLeft === 0) {
            return;
          }

          // Anchor to bottom so items collapse downward when filtered. bottom =
          // viewport height - current top, plus a 24px gap above the @ symbol.
          const windowHeight = window.innerHeight;
          const bottomPosition = windowHeight - currentVisualTop + 24;

          menu.style.setProperty('bottom', `${bottomPosition}px`, 'important');
          menu.style.setProperty('top', 'auto', 'important');
          menu.style.setProperty('left', `${currentVisualLeft}px`, 'important');
          menu.style.setProperty('transform', 'none', 'important');
          menu.style.setProperty('position', 'fixed', 'important');

          // Show menu now that it's in the correct position
          requestAnimationFrame(() => {
            menu.style.setProperty('opacity', '1', 'important');
            menu.style.setProperty('visibility', 'visible', 'important');
          });
        });
      }, 50); // Wait 50ms for plugin to set initial position
    };

    // WeakSet/WeakMap so entries are GC'd when the menu DOM node is removed:
    // the set tracks already-repositioned menus; the map holds each menu's observer for cleanup.
    const repositionedMenus = new WeakSet<HTMLElement>();
    const menuObservers = new WeakMap<HTMLElement, MutationObserver>();

    const observer = new MutationObserver(mutations => {
      mutations.forEach(mutation => {
        if (mutation.type === 'childList') {
          mutation.addedNodes.forEach(node => {
            if (node instanceof HTMLElement) {
              const menu =
                node.classList.contains('beautiful-mentions-menu') ||
                node.classList.contains('custom-mentions-menu-upward')
                  ? node
                  : node.querySelector('.beautiful-mentions-menu, .custom-mentions-menu-upward');

              if (menu instanceof HTMLElement && !repositionedMenus.has(menu)) {
                // Hide menu initially to prevent flicker
                menu.style.setProperty('visibility', 'hidden', 'important');
                menu.style.setProperty('opacity', '0', 'important');

                // Watch this specific menu for ONE position update
                let repositionAttempts = 0;
                const maxAttempts = 3;

                const checkAndReposition = () => {
                  repositionAttempts++;
                  const boundingRect = menu.getBoundingClientRect();

                  // If position looks valid (both coordinates must be positive)
                  if (boundingRect.top > 0 && boundingRect.left > 0 && !repositionedMenus.has(menu)) {
                    repositionedMenus.add(menu);
                    repositionMenu(menu);

                    const obs = menuObservers.get(menu);
                    if (obs) {
                      obs.disconnect();
                      menuObservers.delete(menu);
                    }
                  } else if (repositionAttempts >= maxAttempts) {
                    const obs = menuObservers.get(menu);
                    if (obs) {
                      obs.disconnect();
                      menuObservers.delete(menu);
                    }
                  }
                };

                setTimeout(checkAndReposition, 50);

                // Watch for style changes but only reposition once
                const styleObserver = new MutationObserver(() => {
                  if (!repositionedMenus.has(menu) && repositionAttempts < maxAttempts) {
                    checkAndReposition();
                  }
                });

                menuObservers.set(menu, styleObserver);
                styleObserver.observe(menu, {
                  attributes: true,
                  attributeFilter: ['style'],
                });
              }
            }
          });
        }
      });
    });

    // Observe document.body: the menu is portaled there, so we can't scope to
    // the chat input container.
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['style'],
    });

    // Check for existing menus on mount
    const existingMenus = document.querySelectorAll('.beautiful-mentions-menu, .custom-mentions-menu-upward');
    existingMenus.forEach(menu => {
      if (menu instanceof HTMLElement) {
        repositionMenu(menu);
      }
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  return null;
}
