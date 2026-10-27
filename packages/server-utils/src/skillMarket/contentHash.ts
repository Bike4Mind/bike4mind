import { createHash } from 'crypto';
import type { ISkill } from '@bike4mind/common';

/**
 * Content identity of a skill, EXCLUDING its name: the name is the importer's slash-command handle
 * and may be changed on import to avoid a collision, which must not read as "locally modified".
 */
export function skillContentHash(
  skill: Pick<
    ISkill,
    'description' | 'body' | 'argumentHint' | 'allowedTools' | 'claudeCodeAllowedTools' | 'disableModelInvocation'
  >
): string {
  const parts: unknown[] = [
    skill.description,
    skill.body,
    skill.argumentHint ?? '',
    skill.allowedTools ?? [],
    Boolean(skill.disableModelInvocation),
  ];
  // Appended only when set, so every hash computed before this field existed stays valid.
  if (skill.claudeCodeAllowedTools?.length) parts.push(skill.claudeCodeAllowedTools);
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}
