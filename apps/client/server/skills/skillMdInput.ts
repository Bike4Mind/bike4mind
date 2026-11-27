import { parseSkillMd } from '@bike4mind/common/utils/skillMd';
import type { ISkill, ISkillFile } from '@bike4mind/common';
import { BadRequestError } from '@bike4mind/utils';

/**
 * Turns the text of a SKILL.md into the skill fields the shared validators take, with the same
 * parser and the same rejections as the Skills page import (SkillForm.applySkillMd). The validators
 * in skillWrite.ts then apply the size and format caps, so nothing is checked twice or differently.
 */
export function skillFieldsFromSkillMd(
  skillMd: string,
  { nameOptional = false }: { nameOptional?: boolean } = {}
): {
  fields: Pick<
    ISkill,
    'description' | 'body' | 'argumentHint' | 'claudeCodeAllowedTools' | 'claudeCodeModel' | 'disableModelInvocation'
  > &
    Partial<Pick<ISkill, 'name'>>;
  dropped: string[];
} {
  if (skillMd.includes('\u0000')) {
    throw new BadRequestError('skill_md is not a text file: it contains a NUL byte.');
  }
  if (!/^\uFEFF?---/.test(skillMd)) {
    throw new BadRequestError('No frontmatter found: a SKILL.md starts with a --- block.');
  }
  const parsed = parseSkillMd(skillMd);
  if (!parsed.ok) throw new BadRequestError(parsed.error);
  const { fields, dropped } = parsed;
  if (fields.name === undefined && !nameOptional) {
    throw new BadRequestError('The SKILL.md frontmatter needs a `name`.');
  }
  if (fields.description === undefined) throw new BadRequestError('The SKILL.md frontmatter needs a `description`.');
  return {
    fields: {
      name: fields.name,
      description: fields.description,
      body: fields.body ?? '',
      argumentHint: fields.argumentHint,
      claudeCodeAllowedTools: fields.claudeCodeAllowedTools ?? [],
      claudeCodeModel: fields.claudeCodeModel ?? '',
      disableModelInvocation: fields.disableModelInvocation ?? false,
    },
    dropped,
  };
}

export const filesFromMap = (files: Record<string, string>): ISkillFile[] =>
  Object.entries(files).map(([path, content]) => ({ path, content }));
