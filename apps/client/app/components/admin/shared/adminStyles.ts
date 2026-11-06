import { FIELD_FOCUS_PARTS } from '@client/app/utils/themes/customizations/adminSkin';

export { adminScrollGutter, adminScrollbarVisible } from '@client/app/utils/themes/customizations/adminScrollbar';

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

/**
 * The page frame every admin page sits in (DESIGN_GUIDE section 3, "Page frame"): a 32 px gutter
 * (16 on phones), 24 px above the page header and 32 px below the last region. The shell applies it
 * to each tab panel, and detail routes spread it on their root, so a page never pads itself.
 */
export const adminPageFrame = {
  px: { xs: 2, md: 4 },
  pt: { xs: 2, md: 3 },
  pb: { xs: 3, md: 4 },
};

/** Max content width for detail and settings pages; list pages stay full width. */
export const ADMIN_DETAIL_MAX_WIDTH = 1280;

/** Joy spacing units between page regions (header, banners, filters, table): 24 px. */
export const ADMIN_REGION_GAP = 3;
