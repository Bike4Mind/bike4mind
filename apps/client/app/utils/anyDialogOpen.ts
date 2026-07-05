/**
 * Whether any modal dialog is actually *visible* to the user right now.
 *
 * MUI Joy Modal/Drawer components stay mounted while closed - they render with
 * `role="dialog" aria-modal="true"` but `visibility: hidden`. So a bare
 * `document.querySelector('[role="dialog"][aria-modal="true"]')` matches closed,
 * invisible drawers (Help Center, Advanced Search, Admin, ...) on essentially every
 * authenticated load. That presence-only check previously suppressed the What's New
 * auto-trigger for every user - it must test visibility, not mere presence.
 *
 * `Element.checkVisibility({ visibilityProperty: true })` is purpose-built for this and,
 * unlike an `offsetParent` check, does NOT false-negative on the `position: fixed`
 * elements modals use. We fall back to computed style on engines without checkVisibility
 * (deliberately omitting `offsetParent`, which is null for visible fixed-position modals).
 */
export const isAnyModalDialogOpen = (): boolean => {
  if (typeof document === 'undefined') return false;

  const dialogs = Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'));

  return dialogs.some(el => {
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true, opacityProperty: true });
    }
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  });
};
