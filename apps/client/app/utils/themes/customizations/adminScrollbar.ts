/**
 * The admin's overlay scrollbar (DESIGN_GUIDE.md, "Sidebar"): a 6 px rounded thumb in `inkMuted` at
 * 40% on a transparent track, shown only while the area is hovered or holds focus. Light and dark
 * come from the token. Chromium ignores the `::-webkit-scrollbar` rules on an element that sets
 * `scrollbar-width` or `scrollbar-color`, so the standard properties are for browsers without them.
 */
const thumb = 'color-mix(in srgb, var(--joy-palette-admin-inkMuted) 40%, transparent)';

export const adminScrollbar = {
  '@supports not selector(::-webkit-scrollbar)': {
    scrollbarWidth: 'thin',
    scrollbarColor: 'transparent transparent',
    '&:is(:hover, :focus-within)': { scrollbarColor: `${thumb} transparent` },
  },
  '&::-webkit-scrollbar': { width: '6px', height: '6px' },
  '&::-webkit-scrollbar-track, &::-webkit-scrollbar-corner': { background: 'transparent' },
  '&::-webkit-scrollbar-thumb': { backgroundColor: 'transparent', borderRadius: '999px' },
  '&:is(:hover, :focus-within)::-webkit-scrollbar-thumb': { backgroundColor: thumb },
} as const;

/** Reserves the scrollbar gutter, so content does not shift when the area starts to overflow. */
export const adminScrollGutter = { scrollbarGutter: 'stable' } as const;
