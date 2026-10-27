import { createHash } from 'crypto';
import { compareSkillFilePaths, type ISkill } from '@bike4mind/common';

/**
 * Content identity of a skill, EXCLUDING its name: the name is the importer's slash-command handle
 * and may be changed on import to avoid a collision, which must not read as "locally modified".
 */
export function skillContentHash(
  skill: Pick<ISkill, 'description' | 'body' | 'argumentHint' | 'allowedTools' | 'disableModelInvocation' | 'files'>
): string {
  const fields: unknown[] = [
    skill.description,
    skill.body,
    skill.argumentHint ?? '',
    skill.allowedTools ?? [],
    Boolean(skill.disableModelInvocation),
  ];
  // Appended only when present, so a skill without files keeps the hash it had before files existed.
  if (skill.files?.length) {
    const sorted = [...skill.files].sort(compareSkillFilePaths);
    fields.push(sorted.map(f => [f.path, sha256(f.content)]));
  }
  return sha256(JSON.stringify(fields));
}

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');
