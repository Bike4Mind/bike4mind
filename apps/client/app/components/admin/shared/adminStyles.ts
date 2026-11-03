import { FIELD_FOCUS_PARTS } from '@client/app/utils/themes/customizations/adminSkin';

export { adminScrollGutter } from '@client/app/utils/themes/customizations/adminScrollbar';

const focusRing = {
  // The app theme removes Joy button outlines with !important; admin controls must restore them.
  outline: '2px solid var(--joy-palette-admin-accent) !important',
  outlineOffset: 2,
};
export const adminFocus = { '&&:focus-visible, &&.Mui-focusVisible': focusRing };
// Fields draw their own ring on the root, so neither the root nor its native control takes this one.
export const adminFocusScope = {
  [`&& :focus-visible:not(${FIELD_FOCUS_PARTS}), && .Mui-focusVisible:not(${FIELD_FOCUS_PARTS})`]: focusRing,
};
export const adminSurface = {
  ...adminFocusScope,
  bgcolor: 'admin.surface',
  color: 'admin.ink',
  borderColor: 'admin.border',
  borderRadius: 'md',
};
