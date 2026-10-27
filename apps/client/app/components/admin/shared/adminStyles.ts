export { adminScrollGutter } from '@client/app/utils/themes/customizations/adminScrollbar';

const focusRing = {
  // The app theme removes Joy button outlines with !important; admin controls must restore them.
  outline: '2px solid var(--joy-palette-admin-accent) !important',
  outlineOffset: 2,
};
export const adminFocus = { '&&:focus-visible, &&.Mui-focusVisible': focusRing };
export const adminFocusScope = { '&& :focus-visible, && .Mui-focusVisible': focusRing };
export const adminSurface = {
  ...adminFocusScope,
  bgcolor: 'admin.surface',
  color: 'admin.ink',
  borderColor: 'admin.border',
  borderRadius: 'md',
};
