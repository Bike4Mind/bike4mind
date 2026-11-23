import { z } from 'zod';
import { toViewId, type OrchestratorViewId } from './orchestratorViews';

/**
 * A stage layout is data: one to three panes side by side ('row') or stacked ('column'), each naming a
 * registered view, with sizes as fractions of the stage that sum to 1. Built only from registered views, so a
 * layout can never run code of its own (OrchestratorStage draws each pane with the stage's renderView).
 */
export type LayoutSplit = 'row' | 'column';

export interface OrchestratorPane {
  view: OrchestratorViewId;
  size: number;
}

export interface OrchestratorLayout {
  split: LayoutSplit;
  panes: readonly OrchestratorPane[];
}

export const MAX_PANES = 3;
/** The smallest share of the stage a pane can be dragged or stored down to. */
export const MIN_PANE_FRACTION = 0.2;
/** What an unknown or removed view id in a stored layout becomes. */
export const FALLBACK_PANE_VIEW: OrchestratorViewId = 'board';

/** The stored shape. A view is any string here: an id from a newer or older build falls back, not fails. */
const storedLayoutSchema = z.object({
  split: z.enum(['row', 'column']),
  panes: z
    .array(z.object({ view: z.string(), size: z.number().positive().finite() }))
    .min(1)
    .max(MAX_PANES),
});

export function singlePaneLayout(view: OrchestratorViewId): OrchestratorLayout {
  return { split: 'row', panes: [{ view, size: 1 }] };
}

/**
 * Scales sizes to sum to 1, then pins any pane under MIN_PANE_FRACTION at it and shares the rest among the
 * others in proportion. Each pass pins at least one more pane, so it settles within one pass per pane.
 */
export function fitSizes(sizes: readonly number[]): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  let fitted = sizes.map(size => size / total);
  const pinned = new Set<number>();
  for (;;) {
    const under = fitted.flatMap((size, index) => (!pinned.has(index) && size < MIN_PANE_FRACTION ? [index] : []));
    if (under.length === 0) return fitted;
    under.forEach(index => pinned.add(index));
    const free = fitted.reduce((sum, size, index) => (pinned.has(index) ? sum : sum + size), 0);
    const room = 1 - pinned.size * MIN_PANE_FRACTION;
    fitted = fitted.map((size, index) => (pinned.has(index) ? MIN_PANE_FRACTION : (size / free) * room));
  }
}

function withSizes(
  split: LayoutSplit,
  views: readonly OrchestratorViewId[],
  sizes: readonly number[]
): OrchestratorLayout {
  const fitted = fitSizes(sizes);
  return { split, panes: views.map((view, index) => ({ view, size: fitted[index] })) };
}

/**
 * A stored layout (already JSON-parsed) as a layout, or undefined when it is not one. Unknown view ids become
 * FALLBACK_PANE_VIEW and sizes are refitted, so a layout that parses always lays out.
 */
export function parseLayout(value: unknown): OrchestratorLayout | undefined {
  const parsed = storedLayoutSchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { split, panes } = parsed.data;
  return withSizes(
    split,
    panes.map(pane => toViewId(pane.view) ?? FALLBACK_PANE_VIEW),
    panes.map(pane => pane.size)
  );
}

/** parseLayout for the raw string out of storage; malformed JSON is as unreadable as a bad shape. */
export function parseStoredLayout(stored: string | null): OrchestratorLayout | undefined {
  if (stored === null) return undefined;
  try {
    return parseLayout(JSON.parse(stored));
  } catch {
    return undefined;
  }
}

export type LayoutPresetId = 'single' | 'side-by-side' | 'stacked' | 'three-across';

interface LayoutPreset {
  split: LayoutSplit;
  panes: number;
}

/** Menu order (ViewSwitcher lists them as given). */
export const LAYOUT_PRESETS: Readonly<Record<LayoutPresetId, LayoutPreset>> = {
  single: { split: 'row', panes: 1 },
  'side-by-side': { split: 'row', panes: 2 },
  stacked: { split: 'column', panes: 2 },
  'three-across': { split: 'row', panes: 3 },
};

/** The views a new pane is given, first unused one first: detail next to the shape of the run. */
const NEW_PANE_VIEWS: readonly OrchestratorViewId[] = ['board', 'transit', 'constellation'];

/** The preset `layout` matches by shape, ignoring views and sizes; undefined for a shape no preset has. */
export function presetOf(layout: OrchestratorLayout): LayoutPresetId | undefined {
  const ids = Object.keys(LAYOUT_PRESETS) as LayoutPresetId[];
  return ids.find(id => {
    const preset = LAYOUT_PRESETS[id];
    return preset.panes === layout.panes.length && (preset.panes === 1 || preset.split === layout.split);
  });
}

/** Reshapes to a preset, keeping the panes it already has (in order) and filling new ones; sizes even out. */
export function applyPreset(layout: OrchestratorLayout, presetId: LayoutPresetId): OrchestratorLayout {
  const preset = LAYOUT_PRESETS[presetId];
  const views = layout.panes.slice(0, preset.panes).map(pane => pane.view);
  while (views.length < preset.panes) {
    views.push(NEW_PANE_VIEWS.find(view => !views.includes(view)) ?? FALLBACK_PANE_VIEW);
  }
  return withSizes(
    preset.split,
    views,
    views.map(() => 1)
  );
}

export function setPaneView(layout: OrchestratorLayout, index: number, view: OrchestratorViewId): OrchestratorLayout {
  if (!layout.panes[index]) return layout;
  return { ...layout, panes: layout.panes.map((pane, at) => (at === index ? { ...pane, view } : pane)) };
}

/**
 * Moves the edge after pane `index` by `delta` (a fraction of the stage), trading size between that pane and
 * the next only, and never leaving either under MIN_PANE_FRACTION.
 */
export function resizePanes(layout: OrchestratorLayout, index: number, delta: number): OrchestratorLayout {
  const before = layout.panes[index];
  const after = layout.panes[index + 1];
  if (!before || !after || !Number.isFinite(delta)) return layout;
  const pair = before.size + after.size;
  const size = Math.min(pair - MIN_PANE_FRACTION, Math.max(MIN_PANE_FRACTION, before.size + delta));
  return {
    ...layout,
    panes: layout.panes.map((pane, at) =>
      at === index ? { ...pane, size } : at === index + 1 ? { ...pane, size: pair - size } : pane
    ),
  };
}

export function layoutsEqual(a: OrchestratorLayout, b: OrchestratorLayout): boolean {
  return (
    a.split === b.split &&
    a.panes.length === b.panes.length &&
    a.panes.every((pane, index) => pane.view === b.panes[index].view && pane.size === b.panes[index].size)
  );
}
