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

/** 1 dwarf smith, 2 elf scholar, 3 human ranger, 4 gnome tinkerer (see the assets README). */
export type CharacterId = 1 | 2 | 3 | 4;
export type Pose = 'work' | 'call' | 'rest' | 'ko' | 'idle';

export const TAVERN_BACKDROP: string = backdrop;

const SPRITES: Record<CharacterId, Record<Pose, string>> = {
  1: { work: char1Work, call: char1Call, rest: char1Rest, ko: char1Ko, idle: char1Idle },
  2: { work: char2Work, call: char2Call, rest: char2Rest, ko: char2Ko, idle: char2Idle },
  3: { work: char3Work, call: char3Call, rest: char3Rest, ko: char3Ko, idle: char3Idle },
  4: { work: char4Work, call: char4Call, rest: char4Rest, ko: char4Ko, idle: char4Idle },
};

export function characterSprite(character: CharacterId, pose: Pose): string {
  return SPRITES[character][pose];
}
