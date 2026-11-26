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
import keeperCheering from '../../../assets/orchestrator/aquarium/keeper-cheering.svg';
import keeperIdle from '../../../assets/orchestrator/aquarium/keeper-idle.svg';
import keeperReading from '../../../assets/orchestrator/aquarium/keeper-reading.svg';
import keeperWalking from '../../../assets/orchestrator/aquarium/keeper-walking.svg';
import keeperWriting from '../../../assets/orchestrator/aquarium/keeper-writing.svg';
import type { HostPose } from '../scene/sceneDefinition';

/** A fish's look per state (see the assets README): side-on swimming, nose to the glass, resting, asleep, pale. */
export const FISH_POSES = ['swim', 'front', 'rest', 'sleep', 'pale'] as const;
export type FishPose = (typeof FISH_POSES)[number];

export const AQUARIUM_BACKDROP: string = backdrop;

const SHEETS: readonly Record<FishPose, string>[] = [
  { swim: fish1Swim, front: fish1Front, rest: fish1Rest, sleep: fish1Sleep, pale: fish1Pale },
  { swim: fish2Swim, front: fish2Front, rest: fish2Rest, sleep: fish2Sleep, pale: fish2Pale },
  { swim: fish3Swim, front: fish3Front, rest: fish3Rest, sleep: fish3Sleep, pale: fish3Pale },
  { swim: fish4Swim, front: fish4Front, rest: fish4Rest, sleep: fish4Sleep, pale: fish4Pale },
];

/** Four drawings, each in four hues: sixteen fish before any two in a tank look alike. */
const HUES = [0, 70, 150, 220] as const;

export const FISH_CAST: readonly { look: string; hue: number; sprites: Record<FishPose, string> }[] = HUES.flatMap(
  hue => SHEETS.map((sprites, index) => ({ look: `fish-${index + 1}${hue ? `-hue-${hue}` : ''}`, hue, sprites }))
);

/** The Keeper, the tank's octopus host (drawn by scripts/orchestrator-art/keeper.mjs). */
export const KEEPER_ART: Record<HostPose, string> = {
  idle: keeperIdle,
  writing: keeperWriting,
  reading: keeperReading,
  walking: keeperWalking,
  cheering: keeperCheering,
};
