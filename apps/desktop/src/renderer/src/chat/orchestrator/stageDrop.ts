import { MAX_PANES, addPinnedPane, setPaneSession, type OrchestratorLayout } from './orchestratorLayout';

/**
 * Where a session dropped on the stage goes (StageDropZones): `right` and `bottom` add a pane beside or below,
 * `center` re-pins the pane under the cursor. Pure, so the overlay and tests share one rule.
 */
export type StageDropZone = 'right' | 'bottom' | 'center';

/** The share of the stage, from its right or bottom edge, that counts as that edge's zone. */
export const EDGE_ZONE_FRACTION = 0.3;

/**
 * The zones a layout can take a drop in. The model has one split for every pane, so an edge is offered only
 * when it keeps that split (any edge for a single pane); a full stage offers only re-pinning, and a single pane
 * none, since it always follows the active session.
 */
export function allowedDropZones(layout: OrchestratorLayout): StageDropZone[] {
  const count = layout.panes.length;
  const zones: StageDropZone[] = [];
  if (count < MAX_PANES && (count === 1 || layout.split === 'row')) zones.push('right');
  if (count < MAX_PANES && (count === 1 || layout.split === 'column')) zones.push('bottom');
  if (count > 1) zones.push('center');
  return zones;
}

/**
 * The zone under a point given as fractions (0..1) of the stage's width and height, or undefined when that
 * part of the stage takes no drop. An edge wins over the center; the nearer edge wins where two overlap.
 */
export function dropZoneAt(layout: OrchestratorLayout, { x, y }: { x: number; y: number }): StageDropZone | undefined {
  const allowed = allowedDropZones(layout);
  const edges: { zone: StageDropZone; distance: number }[] = [
    { zone: 'right' as const, distance: 1 - x },
    { zone: 'bottom' as const, distance: 1 - y },
  ].filter(edge => allowed.includes(edge.zone) && edge.distance <= EDGE_ZONE_FRACTION);
  const nearest = edges.sort((a, b) => a.distance - b.distance)[0];
  if (nearest) return nearest.zone;
  return allowed.includes('center') ? 'center' : undefined;
}

/**
 * The layout after dropping `sessionId` in `zone`; `paneIndex` is the pane under the cursor for `center`.
 * Returns the layout unchanged for a zone the layout does not offer.
 */
export function applySessionDrop(
  layout: OrchestratorLayout,
  zone: StageDropZone,
  sessionId: string,
  paneIndex = layout.panes.length - 1
): OrchestratorLayout {
  if (!allowedDropZones(layout).includes(zone)) return layout;
  if (zone === 'center') return setPaneSession(layout, paneIndex, sessionId);
  return addPinnedPane(layout, sessionId, undefined, zone === 'right' ? 'row' : 'column');
}
