import { createHash } from 'crypto';
import type { ISkill } from '@bike4mind/common';

/**
 * Content identity of a skill, EXCLUDING its name: the name is the importer's slash-command handle
 * and may be changed on import to avoid a collision, which must not read as "locally modified".
 */
export function skillContentHash(
  skill: Pick<ISkill, 'description' | 'body' | 'argumentHint' | 'allowedTools' | 'disableModelInvocation'>
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        skill.description,
        skill.body,
        skill.argumentHint ?? '',
        skill.allowedTools ?? [],
        Boolean(skill.disableModelInvocation),
      ])
    )
    .digest('hex');
}
