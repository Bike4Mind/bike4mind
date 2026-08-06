import type { SvgIconComponent } from '@mui/icons-material';
import SortByAlphaIcon from '@mui/icons-material/SortByAlpha';
import SwapVertIcon from '@mui/icons-material/SwapVert';
import { scrollbarStyles } from '@client/app/utils/scrollbarStyles';
import { HUES } from './deckChrome';
import type { Hue } from './deckChrome';

/**
 * Shared chrome for the Data Lake tree surfaces: the in-chat sidebar (DataLakeTree) and the
 * manager modal's navigation (DataLakeManagerPanel). Both must stay visually identical, so
 * the sizing constants, row styling, and tag-namespace display names live here.
 * Row/hover styling mirrors the main app sidenav (layouts/Notebook/Sidenav).
 */

/** How the tree lists order their rows. Both surfaces hold this in state; declared here so a
 *  third mode is added in one place, alongside its icon. */
export type TreeSortMode = 'count' | 'alpha';

/**
 * Sort toggle icon per ACTIVE mode: A-Z gets the alphabet glyph so the mode is readable from the
 * button and not just its tooltip. Count keeps the neutral swap glyph.
 */
export const SORT_MODE_ICON: Record<TreeSortMode, SvgIconComponent> = {
  count: SwapVertIcon,
  alpha: SortByAlphaIcon,
};

/** Shared sizing for the tree's 32px controls (header icons + footer buttons). */
export const CONTROL_SX = { borderRadius: '6px' } as const;
export const ICON_BTN_SX = { ...CONTROL_SX, '--IconButton-size': '32px' } as const;
export const FOOTER_BTN_SX = {
  ...CONTROL_SX,
  flex: 1,
  minHeight: 32,
  height: 32,
  fontWeight: 400,
  fontSize: 14,
} as const;

/**
 * Row sx for tree items (folders/files). ListItemButton reads its hover bg from the Joy var,
 * so a plain '&:hover' would lose to Joy's built-in rule - pass theme.palette.notebooklist.hoverBg.
 */
export const treeRowSx = (hoverBg: string) =>
  ({
    borderRadius: '8px',
    gap: '8px',
    minHeight: '28px',
    py: 0,
    transition: 'background 0.15s',
    '--variant-plainHoverBg': hoverBg,
  }) as const;

/**
 * Count chip rendered as bare text (no pill) to match the sidenav counters.
 * flexShrink: 0 is load-bearing - Joy's Chip label slot sets overflow:hidden + text-overflow:
 * ellipsis, so as a shrinkable flex child a long row name would clip the digits ("360" -> "3...").
 * Pinning it makes the name (minWidth:0 via ListItemContent) absorb all truncation instead.
 */
export const COUNT_CHIP_SX = {
  bgcolor: 'transparent',
  flexShrink: 0,
  '--Chip-paddingInline': '0px',
  '--Chip-minHeight': 'auto',
} as const;

/**
 * Scroll container sx for the tree/nav panes. Uses the same 4px thumb as the main app sidenav
 * (layouts/Notebook/Sidenav/CombinedNotebooks) instead of the platform default bar.
 */
export const TREE_SCROLL_SX = { flex: 1, overflow: 'auto', ...scrollbarStyles } as const;

/**
 * Wrapper that pins the breadcrumb back row to the top of its scroll pane, so going up a level
 * stays reachable in a long branch. Mirrors the sidenav's pinned nav: an opaque backdrop in the
 * card's own surface colour lets rows scroll UNDER it rather than through it. The 4px gap below
 * the row lives here rather than on the button, so no sliver of moving content shows in it.
 *
 * Only needed where the back row is INSIDE the scroll container (the in-chat tree and the manager
 * nav). DataLakeTree/DataLakeViewer render theirs as a sibling above the scroll pane already.
 */
export const TREE_BACK_STICKY_SX = {
  position: 'sticky',
  top: 0,
  zIndex: 2,
  backgroundColor: 'background.surface2',
  pb: '4px',
} as const;

/** Breadcrumb back row, sized to match the folder/file rows above it. */
export const treeBackRowSx = (hoverBg: string) =>
  ({
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    px: '8px',
    height: '32px',
    minHeight: '32px',
    borderRadius: '8px',
    transition: 'background 0.15s',
    '--variant-plainHoverBg': hoverBg,
  }) as const;

/** List container vars shared by the tree/file lists. */
export const TREE_LIST_SX = {
  py: 0,
  '--List-gap': '4px',
  '--ListItem-paddingX': '8px',
  '--ListItem-paddingY': '0px',
} as const;

const PREFIX_LABELS: Record<string, string> = {
  opti: 'Optimization Knowledge',
};

/** Hue-code branches by their top-level prefix so different root namespaces read apart at a
 *  glance. Only `opti` gets a distinct hue today; every other branch falls back to amber. */
const PREFIX_HUES: Record<string, Hue> = {
  opti: HUES.emerald,
};

export const hueForBranch = (segment: string, breadcrumb: string[]): Hue =>
  PREFIX_HUES[breadcrumb[0] ?? segment] ?? HUES.amber;

const CATEGORY_LABELS: Record<string, string> = {
  offering: 'Offering Lines',
  type: 'Content Type',
  vertical: 'Customer Verticals',
  competitor: 'Competitors',
  stage: 'Sales Stage',
  content: 'Content Type',
  family: 'Pattern Families',
  solver: 'Solvers',
  level: 'Difficulty Level',
  industry: 'Industries',
};

export function humanizeSegment(segment: string, depth: number): string {
  if (depth === 0 && PREFIX_LABELS[segment]) return PREFIX_LABELS[segment];
  if (depth === 1 && CATEGORY_LABELS[segment]) return CATEGORY_LABELS[segment];
  return segment.charAt(0).toUpperCase() + segment.slice(1).replace(/-/g, ' ');
}
