import { createHash } from 'crypto';
import { compareSkillFilePaths, type ISkill } from '@bike4mind/common';

/**
 * Content identity of a skill, EXCLUDING its name: the name is the importer's slash-command handle
 * and may be changed on import to avoid a collision, which must not read as "locally modified".
 */
export function skillContentHash(
  skill: Pick<
    ISkill,
    | 'description'
    | 'body'
    | 'argumentHint'
    | 'allowedTools'
    | 'claudeCodeAllowedTools'
    | 'disableModelInvocation'
    | 'files'
  >
): string {
  const parts: unknown[] = [
    skill.description,
    skill.body,
    skill.argumentHint ?? '',
    skill.allowedTools ?? [],
    Boolean(skill.disableModelInvocation),
  ];
  // Each optional field is appended only when set, so every hash computed before it existed stays
  // valid. Keep the order: claudeCodeAllowedTools shipped first, files after it.
  if (skill.claudeCodeAllowedTools?.length) parts.push(skill.claudeCodeAllowedTools);
  if (skill.files?.length) {
    const sorted = [...skill.files].sort(compareSkillFilePaths);
    parts.push(sorted.map(f => [f.path, sha256(f.content)]));
  }
  return sha256(JSON.stringify(parts));
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
