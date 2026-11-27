import type { SceneDefinition, ScenePoint } from './sceneDefinition';

type Occluder = SceneDefinition['map']['occluders'][number];

/**
 * How much of a sprite standing at `point` the scene's furniture hides, as a percent of its box from
 * the bottom. Feet behind a counter stand on floor the backdrop never shows, so everything below the
 * counter top is cut away; anywhere else the sprite is whole and stands on visible floor.
 */
export function hiddenBehind(point: ScenePoint, spriteHeight: number, occluders: readonly Occluder[]): number {
  let hidden = 0;
  for (const occluder of occluders) {
    const behind = point.x >= occluder.left && point.x <= occluder.right && point.y < occluder.front;
    if (behind) hidden = Math.max(hidden, Math.min(100, Math.max(0, ((point.y - occluder.top) / spriteHeight) * 100)));
  }
  return hidden;
}

/**
 * A name label's height cap and the drop of its second line, as a percent of scene height. Labels
 * whose tops are at least this far apart can never meet.
 */
export const LABEL_SPAN = 4.5;
/** Widest a name label gets, as a percent of scene width. */
export const NAME_LABEL_MAX_WIDTH = 16;
/** Below this width (percent of scene width) a label would show only an ellipsis, so it is not drawn. */
export const NAME_LABEL_MIN_WIDTH = 4;
const LABEL_GUTTER = 0.5;

/** `lane` 1 drops the label one LABEL_SPAN below its usual line; `maxWidth` is a percent of scene width. */
export type NameLabel = { lane: 0 | 1; maxWidth: number; shown: boolean };

type LaidOut = { point: ScenePoint; lane: 0 | 1 };

/**
 * Widest a label at `point` on `lane` can be without meeting any of `others` or running past the
 * scene's side walls (the scene clips it), all centred under their points.
 */
function labelCap(point: ScenePoint, lane: 0 | 1, others: Iterable<LaidOut>): number {
  const top = point.y + lane * LABEL_SPAN;
  let cap = Math.min(NAME_LABEL_MAX_WIDTH, 2 * (Math.min(point.x, 100 - point.x) - LABEL_GUTTER));
  for (const other of others) {
    if (Math.abs(other.point.y + other.lane * LABEL_SPAN - top) >= LABEL_SPAN) continue;
    cap = Math.min(cap, Math.abs(other.point.x - point.x) - LABEL_GUTTER);
  }
  return Math.max(0, cap);
}

/**
 * Lays out the name labels so no two drawn ones overlap at rest. Left to right, each label takes the
 * line (its own, or one span lower) that leaves it wider, which staggers alternate neighbours in a
 * crowded row; then each is capped to its gap to every label it shares a line with. All in scene
 * units, so it holds at any stage size.
 */
export function nameLabelLayout(points: ReadonlyMap<string, ScenePoint>): Map<string, NameLabel> {
  const lanes = new Map<string, LaidOut>();
  const leftToRight = [...points].sort(([, a], [, b]) => a.x - b.x || a.y - b.y);
  for (const [id, point] of leftToRight) {
    const placed = [...lanes.values()];
    const lane = labelCap(point, 1, placed) > labelCap(point, 0, placed) ? 1 : 0;
    lanes.set(id, { point, lane });
  }

  const layout = new Map<string, NameLabel>();
  for (const [id, point] of points) {
    const own = lanes.get(id);
    if (!own) continue;
    const others = [...lanes].filter(([otherId]) => otherId !== id).map(([, other]) => other);
    const maxWidth = labelCap(point, own.lane, others);
    layout.set(id, { lane: own.lane, maxWidth, shown: maxWidth >= NAME_LABEL_MIN_WIDTH });
  }
  return layout;
}

export type WaitingSeat = { id: string; zone: string; point: ScenePoint };

/**
 * Agents waiting in one zone share a single "needs you" bubble. Seats are closer together than
 * the bubble is wide at most stage sizes (the Tavern's bar seats are 6% of the scene apart, the
 * bubble 5% to 28%, since its text has a pixel floor), so one bubble each would pile up. Returns the
 * agent each zone's bubble sits over, the one nearest the group's middle (leftmost on a tie), and
 * the ids it speaks for, left to right.
 */
export function needsYouGroups(waiting: Iterable<WaitingSeat>): Map<string, string[]> {
  const byZone = new Map<string, WaitingSeat[]>();
  for (const seat of waiting) byZone.set(seat.zone, [...(byZone.get(seat.zone) ?? []), seat]);
  const carriers = new Map<string, string[]>();
  for (const group of byZone.values()) {
    const total = group.reduce((sum, seat) => sum + seat.point.x, 0);
    // Scaled by the group size so the middle stays exact for whole-number seats.
    const offset = (seat: WaitingSeat) => Math.abs(group.length * seat.point.x - total);
    const carrier = group.reduce((best, seat) =>
      offset(seat) < offset(best) || (offset(seat) === offset(best) && seat.point.x < best.point.x) ? seat : best
    );
    const ordered = [...group].sort((a, b) => a.point.x - b.point.x);
    carriers.set(
      carrier.id,
      ordered.map(seat => seat.id)
    );
  }
  return carriers;
}
