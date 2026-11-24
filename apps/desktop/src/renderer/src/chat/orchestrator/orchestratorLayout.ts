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
  /**
   * The session whose roster this pane shows; absent means it follows the active session. Resolved at render
   * time (panePins.ts), so an id that is no longer listed falls back to the active session rather than failing.
   */
  sessionId?: string;
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

/**
 * The stored shape. A view is any string here: an id from a newer or older build falls back, not fails. A bad
 * session pin is dropped on its own, so the pane follows the active session instead of losing the layout.
 */
const storedLayoutSchema = z.object({
  split: z.enum(['row', 'column']),
  panes: z
    .array(
      z.object({
        view: z.string(),
        size: z.number().positive().finite(),
        sessionId: z.string().min(1).optional().catch(undefined),
      })
    )
    .min(1)
    .max(MAX_PANES),
});

type UnsizedPane = Omit<OrchestratorPane, 'size'>;

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

function withSizes(split: LayoutSplit, panes: readonly UnsizedPane[], sizes: readonly number[]): OrchestratorLayout {
  const fitted = fitSizes(sizes);
  return { split, panes: panes.map((pane, index) => ({ ...pane, size: fitted[index] })) };
}

function paneOf(view: OrchestratorViewId, sessionId: string | undefined): UnsizedPane {
  return sessionId === undefined ? { view } : { view, sessionId };
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
    panes.map(pane => paneOf(toViewId(pane.view) ?? FALLBACK_PANE_VIEW, pane.sessionId)),
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

/**
 * Reshapes to a preset, keeping the panes it already has (in order, with their pins) and filling new ones;
 * sizes even out. A single pane always follows the active session, so going to one pane drops its pin.
 */
export function applyPreset(layout: OrchestratorLayout, presetId: LayoutPresetId): OrchestratorLayout {
  const preset = LAYOUT_PRESETS[presetId];
  const panes: UnsizedPane[] = layout.panes
    .slice(0, preset.panes)
    .map(pane => paneOf(pane.view, preset.panes > 1 ? pane.sessionId : undefined));
  while (panes.length < preset.panes) {
    const used = panes.map(pane => pane.view);
    panes.push({ view: NEW_PANE_VIEWS.find(view => !used.includes(view)) ?? FALLBACK_PANE_VIEW });
  }
  return withSizes(
    preset.split,
    panes,
    panes.map(() => 1)
  );
}

export function setPaneView(layout: OrchestratorLayout, index: number, view: OrchestratorViewId): OrchestratorLayout {
  if (!layout.panes[index]) return layout;
  return { ...layout, panes: layout.panes.map((pane, at) => (at === index ? { ...pane, view } : pane)) };
}

/** Pins pane `index` to a session; undefined unpins it, so it follows the active session again. */
export function setPaneSession(
  layout: OrchestratorLayout,
  index: number,
  sessionId: string | undefined
): OrchestratorLayout {
  if (!layout.panes[index]) return layout;
  return {
    ...layout,
    panes: layout.panes.map((pane, at) => (at === index ? { ...paneOf(pane.view, sessionId), size: pane.size } : pane)),
  };
}

/**
 * Adds a pane showing `sessionId` beside the others: a new last pane while there is room (sizes even out, as
 * applyPreset does), else the last pane is re-pinned. `split` reshapes a single pane only; a split keeps its
 * own, since the model has one split for every pane. A session already pinned in a pane changes nothing.
 */
export function addPinnedPane(
  layout: OrchestratorLayout,
  sessionId: string,
  view: OrchestratorViewId = FALLBACK_PANE_VIEW,
  split: LayoutSplit = layout.split
): OrchestratorLayout {
  if (layout.panes.some(pane => pane.sessionId === sessionId)) return layout;
  if (layout.panes.length >= MAX_PANES) return setPaneSession(layout, layout.panes.length - 1, sessionId);
  const panes: UnsizedPane[] = [...layout.panes.map(pane => paneOf(pane.view, pane.sessionId)), { view, sessionId }];
  return withSizes(
    layout.panes.length === 1 ? split : layout.split,
    panes,
    panes.map(() => 1)
  );
}

/** The layout with every pin dropped: what a scope shared by other sessions remembers (orchestratorPrefs.ts). */
export function withoutPins(layout: OrchestratorLayout): OrchestratorLayout {
  if (layout.panes.every(pane => pane.sessionId === undefined)) return layout;
  return { ...layout, panes: layout.panes.map(pane => ({ view: pane.view, size: pane.size })) };
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
    a.panes.every(
      (pane, index) =>
        pane.view === b.panes[index].view &&
        pane.size === b.panes[index].size &&
        pane.sessionId === b.panes[index].sessionId
    )
  );
}
