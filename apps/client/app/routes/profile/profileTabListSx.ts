// Tab strip layout for the /profile tab list.
//
// `gap: 1` (8px theme spacing) keeps visible whitespace between tabs so a tab's
// leading icon never abuts the previous tab's text; a smaller gap (e.g. 2px)
// makes the strip read as a single run of icons + text.
//
// The gap alone is not enough: with many tabs (e.g. superadmin sees 9) the strip
// is wider than its container. By default flex items shrink to fit, so the leftmost
// tabs get compressed below their content width and their centered icon+label
// (overflow: visible) spills past the box edges into neighbors. `flexShrink: 0` on
// each tab stops the compression, `flexWrap: 'nowrap'` keeps the strip on one row,
// and `overflowX: 'auto'` lets the now-unshrinkable strip scroll inside its
// (already width-constrained) container instead of overlapping.
export const profileTabListSx = {
  justifyContent: 'start',
  gap: 1,
  flexWrap: 'nowrap',
  overflowX: 'auto',
  '& .MuiTab-root': {
    flexDirection: {
      xs: 'column',
      sm: 'row',
    },
    alignItems: 'center',
    padding: '4px 12px',
    flexShrink: 0,
  },
} as const;
