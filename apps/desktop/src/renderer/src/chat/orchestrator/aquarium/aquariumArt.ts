import backdrop from '../../../assets/orchestrator/aquarium/backdrop.png';
import fish1Swim from '../../../assets/orchestrator/aquarium/fish-1-swim.png';
import fish1Front from '../../../assets/orchestrator/aquarium/fish-1-front.png';
import fish1Rest from '../../../assets/orchestrator/aquarium/fish-1-rest.png';
import fish1Sleep from '../../../assets/orchestrator/aquarium/fish-1-sleep.png';
import fish1Pale from '../../../assets/orchestrator/aquarium/fish-1-pale.png';
import fish2Swim from '../../../assets/orchestrator/aquarium/fish-2-swim.png';
import fish2Front from '../../../assets/orchestrator/aquarium/fish-2-front.png';
import fish2Rest from '../../../assets/orchestrator/aquarium/fish-2-rest.png';
import fish2Sleep from '../../../assets/orchestrator/aquarium/fish-2-sleep.png';
import fish2Pale from '../../../assets/orchestrator/aquarium/fish-2-pale.png';
import fish3Swim from '../../../assets/orchestrator/aquarium/fish-3-swim.png';
import fish3Front from '../../../assets/orchestrator/aquarium/fish-3-front.png';
import fish3Rest from '../../../assets/orchestrator/aquarium/fish-3-rest.png';
import fish3Sleep from '../../../assets/orchestrator/aquarium/fish-3-sleep.png';
import fish3Pale from '../../../assets/orchestrator/aquarium/fish-3-pale.png';
import fish4Swim from '../../../assets/orchestrator/aquarium/fish-4-swim.png';
import fish4Front from '../../../assets/orchestrator/aquarium/fish-4-front.png';
import fish4Rest from '../../../assets/orchestrator/aquarium/fish-4-rest.png';
import fish4Sleep from '../../../assets/orchestrator/aquarium/fish-4-sleep.png';
import fish4Pale from '../../../assets/orchestrator/aquarium/fish-4-pale.png';

/** A fish's look per state (see the assets README): side-on swimming, nose to the glass, resting, asleep, pale. */
export type FishPose = 'swim' | 'front' | 'rest' | 'sleep' | 'pale';

export const AQUARIUM_BACKDROP: string = backdrop;

const SHEETS: readonly Record<FishPose, string>[] = [
  { swim: fish1Swim, front: fish1Front, rest: fish1Rest, sleep: fish1Sleep, pale: fish1Pale },
  { swim: fish2Swim, front: fish2Front, rest: fish2Rest, sleep: fish2Sleep, pale: fish2Pale },
  { swim: fish3Swim, front: fish3Front, rest: fish3Rest, sleep: fish3Sleep, pale: fish3Pale },
  { swim: fish4Swim, front: fish4Front, rest: fish4Rest, sleep: fish4Sleep, pale: fish4Pale },
];

/** How many distinct fish the art gives before tinting: four sheets, each in four hues. */
const HUES = [0, 70, 150, 220] as const;
export const FISH_LOOKS = SHEETS.length * HUES.length;

export interface FishLook {
  sheet: number;
  /** Degrees for a CSS hue-rotate; 0 for the sheet as drawn. */
  hue: number;
}

/** A small stable hash, so an agent keeps its fish as the roster around it changes. */
export function idHash(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function fishLook(id: string): FishLook {
  const look = idHash(id) % FISH_LOOKS;
  return { sheet: look % SHEETS.length, hue: HUES[Math.floor(look / SHEETS.length)] };
}

export function fishSprite(look: FishLook, pose: FishPose): string {
  return SHEETS[look.sheet][pose];
}
