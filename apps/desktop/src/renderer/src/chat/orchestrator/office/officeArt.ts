import backdrop from '../../../assets/orchestrator/office/backdrop.png';
import char1Call from '../../../assets/orchestrator/office/char-1-call.png';
import char1Idle from '../../../assets/orchestrator/office/char-1-idle.png';
import char1Rest from '../../../assets/orchestrator/office/char-1-rest.png';
import char1Work from '../../../assets/orchestrator/office/char-1-work.png';
import char2Call from '../../../assets/orchestrator/office/char-2-call.png';
import char2Idle from '../../../assets/orchestrator/office/char-2-idle.png';
import char2Rest from '../../../assets/orchestrator/office/char-2-rest.png';
import char2Work from '../../../assets/orchestrator/office/char-2-work.png';
import char3Call from '../../../assets/orchestrator/office/char-3-call.png';
import char3Idle from '../../../assets/orchestrator/office/char-3-idle.png';
import char3Rest from '../../../assets/orchestrator/office/char-3-rest.png';
import char3Work from '../../../assets/orchestrator/office/char-3-work.png';
import char4Call from '../../../assets/orchestrator/office/char-4-call.png';
import char4Idle from '../../../assets/orchestrator/office/char-4-idle.png';
import char4Rest from '../../../assets/orchestrator/office/char-4-rest.png';
import char4Work from '../../../assets/orchestrator/office/char-4-work.png';
import char5Call from '../../../assets/orchestrator/office/char-5-call.png';
import char5Idle from '../../../assets/orchestrator/office/char-5-idle.png';
import char5Rest from '../../../assets/orchestrator/office/char-5-rest.png';
import char5Work from '../../../assets/orchestrator/office/char-5-work.png';
import char6Call from '../../../assets/orchestrator/office/char-6-call.png';
import char6Idle from '../../../assets/orchestrator/office/char-6-idle.png';
import char6Rest from '../../../assets/orchestrator/office/char-6-rest.png';
import char6Work from '../../../assets/orchestrator/office/char-6-work.png';
import char7Call from '../../../assets/orchestrator/office/char-7-call.png';
import char7Idle from '../../../assets/orchestrator/office/char-7-idle.png';
import char7Rest from '../../../assets/orchestrator/office/char-7-rest.png';
import char7Work from '../../../assets/orchestrator/office/char-7-work.png';
import char8Call from '../../../assets/orchestrator/office/char-8-call.png';
import char8Idle from '../../../assets/orchestrator/office/char-8-idle.png';
import char8Rest from '../../../assets/orchestrator/office/char-8-rest.png';
import char8Work from '../../../assets/orchestrator/office/char-8-work.png';
import managerCheering from '../../../assets/orchestrator/office/manager-cheering.png';
import managerIdle from '../../../assets/orchestrator/office/manager-idle.png';
import managerReading from '../../../assets/orchestrator/office/manager-reading.png';
import managerWalking from '../../../assets/orchestrator/office/manager-walking.png';
import managerWriting from '../../../assets/orchestrator/office/manager-writing.png';

import type { Epithet } from '@shared/agentPersona';

export type OfficePose = 'work' | 'call' | 'rest' | 'idle';

export const OFFICE_BACKDROP: string = backdrop;

/**
 * The staff, one entry per sheet rendered from the Office's SVG pixel art by
 * scripts/orchestrator-art/office/render.mjs, in `char-<n>-*` order. Add a look there when adding one here.
 */
export const OFFICE_CAST = [
  {
    look: 'light blue shirt',
    craft: 'Seeker',
    sprites: { work: char1Work, call: char1Call, rest: char1Rest, idle: char1Idle },
  },
  {
    look: 'glasses and a mustard shirt',
    craft: 'Scribe',
    sprites: { work: char2Work, call: char2Call, rest: char2Rest, idle: char2Idle },
  },
  {
    look: 'long auburn hair',
    craft: 'Wanderer',
    sprites: { work: char3Work, call: char3Call, rest: char3Rest, idle: char3Idle },
  },
  {
    look: 'pale blue shirt',
    craft: 'Tinkerer',
    sprites: { work: char4Work, call: char4Call, rest: char4Rest, idle: char4Idle },
  },
  {
    look: 'glasses and long hair',
    craft: 'Cartographer',
    sprites: { work: char5Work, call: char5Call, rest: char5Rest, idle: char5Idle },
  },
  {
    look: 'mint shirt',
    craft: 'Warden',
    sprites: { work: char6Work, call: char6Call, rest: char6Rest, idle: char6Idle },
  },
  {
    look: 'receding hairline',
    craft: 'Scribe',
    sprites: { work: char7Work, call: char7Call, rest: char7Rest, idle: char7Idle },
  },
  {
    look: 'long black hair',
    craft: 'Tinkerer',
    sprites: { work: char8Work, call: char8Call, rest: char8Rest, idle: char8Idle },
  },
] as const satisfies readonly { look: string; craft: Epithet; sprites: Record<OfficePose, string> }[];

export const MANAGER_ART = {
  idle: managerIdle,
  writing: managerWriting,
  reading: managerReading,
  walking: managerWalking,
  cheering: managerCheering,
};
