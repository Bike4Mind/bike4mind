import type { AgentState } from '@shared/agentState';
import type { ViewAction, ViewAgent, ViewSnapshot } from '@shared/viewSnapshot';
import { idHash, type FishPose } from './aquariumArt';

/**
 * Where each fish is in the tank. Bands are percents of the scene box and match backdrop.png (assets
 * README): plants fill the outer sixth on each side, and the sand bed is the bottom fifth.
 */
export type FishZone = 'midwater' | 'glass' | 'low' | 'sand';

const STATE_PLACE: Record<AgentState, { pose: FishPose; zone: FishZone }> = {
  'needs-you': { pose: 'front', zone: 'glass' },
  working: { pose: 'swim', zone: 'midwater' },
  done: { pose: 'rest', zone: 'low' },
  failed: { pose: 'pale', zone: 'sand' },
  stopped: { pose: 'sleep', zone: 'sand' },
  idle: { pose: 'sleep', zone: 'sand' },
};

/** Each resting zone's horizontal span (of fish centres) and its fish's baseline. */
const ZONE_BOX: Record<Exclude<FishZone, 'midwater'>, { from: number; to: number; y: number }> = {
  glass: { from: 30, to: 70, y: 80 },
  low: { from: 24, to: 76, y: 72 },
  sand: { from: 18, to: 82, y: 93 },
};
/** Swimmers go back and forth across the open water between the plants, one lane each. */
export const MIDWATER_LANE = { from: 20, to: 80 };
/** Lanes spread over this band, top to bottom. */
const MIDWATER_TOP = 26;
const MIDWATER_BOTTOM = 56;

export interface Swim {
  /** Seconds for one there-and-back length of the lane. */
  durationS: number;
  /** A negative start (s), so swimmers are not all at the same point of their length. */
  delayS: number;
}

export interface FishPlacement {
  agent: ViewAgent;
  pose: FishPose;
  zone: FishZone;
  /** Centre of the fish (or, for a swimmer, of its lane), percent of the scene width. */
  x: number;
  /** The fish's lowest point, percent of the scene height. */
  y: number;
  swim?: Swim;
}

function spread(count: number, index: number, from: number, to: number): number {
  return from + ((index + 0.5) * (to - from)) / count;
}

/**
 * One placement per agent. Within a zone fish are ordered by a hash of their id, so a fish keeps its
 * spot while others come and go in other zones.
 */
export function placeFish(agents: readonly ViewAgent[]): FishPlacement[] {
  const byZone = new Map<FishZone, ViewAgent[]>();
  for (const agent of agents) {
    const { zone } = STATE_PLACE[agent.state];
    byZone.set(zone, [...(byZone.get(zone) ?? []), agent]);
  }
  const placements: FishPlacement[] = [];
  for (const [zone, members] of byZone) {
    const ordered = [...members].sort((a, b) => idHash(a.id) - idHash(b.id) || a.id.localeCompare(b.id));
    ordered.forEach((agent, index) => {
      const { pose } = STATE_PLACE[agent.state];
      if (zone === 'midwater') {
        const hash = idHash(agent.id);
        const durationS = 22 + (hash % 13);
        placements.push({
          agent,
          pose,
          zone,
          x: (MIDWATER_LANE.from + MIDWATER_LANE.to) / 2,
          y: spread(ordered.length, index, MIDWATER_TOP, MIDWATER_BOTTOM),
          swim: { durationS, delayS: -((hash >>> 8) % durationS) },
        });
        return;
      }
      const box = ZONE_BOX[zone];
      placements.push({ agent, pose, zone, x: spread(ordered.length, index, box.from, box.to), y: box.y });
    });
  }
  return placements;
}

/** The lamp on the glass glows while anyone waits on the user; it opens the root first, as Focus does. */
export function lampAction(snapshot: ViewSnapshot): ViewAction | undefined {
  if (snapshot.root.state === 'needs-you') return { kind: 'open-root' };
  const asking = snapshot.agents.find(agent => agent.state === 'needs-you');
  return asking && { kind: 'open-agent', agentId: asking.id };
}
