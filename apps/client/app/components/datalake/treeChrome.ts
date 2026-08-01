import { HUES } from './deckChrome';
import type { Hue } from './deckChrome';

/**
 * Shared chrome for the Data Lake tree surfaces: the in-chat sidebar (DataLakeTree) and the
 * manager modal's navigation (DataLakeManagerPanel). Both must stay visually identical, so
 * the sizing constants, row styling, and tag-namespace display names live here.
 * Row/hover styling mirrors the main app sidenav (layouts/Notebook/Sidenav).
 */

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

/** Count chip rendered as bare text (no pill) to match the sidenav counters. */
export const COUNT_CHIP_SX = {
  bgcolor: 'transparent',
  '--Chip-paddingInline': '0px',
  '--Chip-minHeight': 'auto',
} as const;

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
