import backdrop from '../../../assets/orchestrator/tavern/backdrop.png';
import char1Call from '../../../assets/orchestrator/tavern/char-1-call.png';
import char1Idle from '../../../assets/orchestrator/tavern/char-1-idle.png';
import char1Ko from '../../../assets/orchestrator/tavern/char-1-ko.png';
import char1Rest from '../../../assets/orchestrator/tavern/char-1-rest.png';
import char1Work from '../../../assets/orchestrator/tavern/char-1-work.png';
import char2Call from '../../../assets/orchestrator/tavern/char-2-call.png';
import char2Idle from '../../../assets/orchestrator/tavern/char-2-idle.png';
import char2Ko from '../../../assets/orchestrator/tavern/char-2-ko.png';
import char2Rest from '../../../assets/orchestrator/tavern/char-2-rest.png';
import char2Work from '../../../assets/orchestrator/tavern/char-2-work.png';
import char3Call from '../../../assets/orchestrator/tavern/char-3-call.png';
import char3Idle from '../../../assets/orchestrator/tavern/char-3-idle.png';
import char3Ko from '../../../assets/orchestrator/tavern/char-3-ko.png';
import char3Rest from '../../../assets/orchestrator/tavern/char-3-rest.png';
import char3Work from '../../../assets/orchestrator/tavern/char-3-work.png';
import char4Call from '../../../assets/orchestrator/tavern/char-4-call.png';
import char4Idle from '../../../assets/orchestrator/tavern/char-4-idle.png';
import char4Ko from '../../../assets/orchestrator/tavern/char-4-ko.png';
import char4Rest from '../../../assets/orchestrator/tavern/char-4-rest.png';
import char4Work from '../../../assets/orchestrator/tavern/char-4-work.png';
import char5Call from '../../../assets/orchestrator/tavern/char-5-call.png';
import char5Idle from '../../../assets/orchestrator/tavern/char-5-idle.png';
import char5Ko from '../../../assets/orchestrator/tavern/char-5-ko.png';
import char5Rest from '../../../assets/orchestrator/tavern/char-5-rest.png';
import char5Work from '../../../assets/orchestrator/tavern/char-5-work.png';
import char6Call from '../../../assets/orchestrator/tavern/char-6-call.png';
import char6Idle from '../../../assets/orchestrator/tavern/char-6-idle.png';
import char6Ko from '../../../assets/orchestrator/tavern/char-6-ko.png';
import char6Rest from '../../../assets/orchestrator/tavern/char-6-rest.png';
import char6Work from '../../../assets/orchestrator/tavern/char-6-work.png';
import char7Call from '../../../assets/orchestrator/tavern/char-7-call.png';
import char7Idle from '../../../assets/orchestrator/tavern/char-7-idle.png';
import char7Ko from '../../../assets/orchestrator/tavern/char-7-ko.png';
import char7Rest from '../../../assets/orchestrator/tavern/char-7-rest.png';
import char7Work from '../../../assets/orchestrator/tavern/char-7-work.png';
import char8Call from '../../../assets/orchestrator/tavern/char-8-call.png';
import char8Idle from '../../../assets/orchestrator/tavern/char-8-idle.png';
import char8Ko from '../../../assets/orchestrator/tavern/char-8-ko.png';
import char8Rest from '../../../assets/orchestrator/tavern/char-8-rest.png';
import char8Work from '../../../assets/orchestrator/tavern/char-8-work.png';
import innkeeperCheering from '../../../assets/orchestrator/tavern/innkeeper-cheering.png';
import innkeeperIdle from '../../../assets/orchestrator/tavern/innkeeper-idle.png';
import innkeeperReading from '../../../assets/orchestrator/tavern/innkeeper-reading.png';
import innkeeperWalking from '../../../assets/orchestrator/tavern/innkeeper-walking.png';
import innkeeperWriting from '../../../assets/orchestrator/tavern/innkeeper-writing.png';

import type { Epithet } from '@shared/agentPersona';

export type Pose = 'work' | 'call' | 'rest' | 'ko' | 'idle';

export const TAVERN_BACKDROP: string = backdrop;

/**
 * The cast, one entry per character sheet (see the assets README). `craft` is the kind of work the
 * character looks the part for, so an agent doing that work is given them first when they are free.
 */
const CAST = [
  {
    look: 'dwarf smith',
    craft: 'Tinkerer',
    sprites: { work: char1Work, call: char1Call, rest: char1Rest, ko: char1Ko, idle: char1Idle },
  },
  {
    look: 'elf scholar',
    craft: 'Scribe',
    sprites: { work: char2Work, call: char2Call, rest: char2Rest, ko: char2Ko, idle: char2Idle },
  },
  {
    look: 'human ranger',
    craft: 'Seeker',
    sprites: { work: char3Work, call: char3Call, rest: char3Rest, ko: char3Ko, idle: char3Idle },
  },
  {
    look: 'gnome tinkerer',
    craft: 'Tinkerer',
    sprites: { work: char4Work, call: char4Call, rest: char4Rest, ko: char4Ko, idle: char4Idle },
  },
  {
    look: 'halfling bard',
    craft: 'Scribe',
    sprites: { work: char5Work, call: char5Call, rest: char5Rest, ko: char5Ko, idle: char5Idle },
  },
  {
    look: 'orc alchemist',
    craft: 'Seeker',
    sprites: { work: char6Work, call: char6Call, rest: char6Rest, ko: char6Ko, idle: char6Idle },
  },
  {
    look: 'human knight',
    craft: 'Warden',
    sprites: { work: char7Work, call: char7Call, rest: char7Rest, ko: char7Ko, idle: char7Idle },
  },
  {
    look: 'cat-folk cartographer',
    craft: 'Cartographer',
    sprites: { work: char8Work, call: char8Call, rest: char8Rest, ko: char8Ko, idle: char8Idle },
  },
] as const satisfies readonly { look: string; craft: Epithet; sprites: Record<Pose, string> }[];

/** 1-based, matching the `char-<id>-*` file names. */
export type CharacterId = number;

export const CHARACTER_COUNT = CAST.length;

export function characterCraft(character: CharacterId): Epithet {
  return castMember(character).craft;
}

export function characterSprite(character: CharacterId, pose: Pose): string {
  return castMember(character).sprites[pose];
}

function castMember(character: CharacterId) {
  const member = CAST[character - 1];
  if (!member) throw new Error(`no tavern character ${character}`);
  return member;
}

export type InnkeeperPose = 'idle' | 'writing' | 'reading' | 'walking' | 'cheering';

/** The one place the Innkeeper's art is chosen; the sprites come from their own sheet (see the assets README). */
export const INNKEEPER_ART: Record<InnkeeperPose, string> = {
  idle: innkeeperIdle,
  writing: innkeeperWriting,
  reading: innkeeperReading,
  walking: innkeeperWalking,
  cheering: innkeeperCheering,
};
