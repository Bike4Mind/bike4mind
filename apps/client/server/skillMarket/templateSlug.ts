import {
  BadRequestError,
  claudeSkillNameFor,
  SKILL_TEMPLATE_RESERVED_SLUGS,
  SKILL_TEMPLATE_SLUG_MAX,
  skillTemplateSlugProblem,
} from '@bike4mind/common';

/** Room kept under SKILL_TEMPLATE_SLUG_MAX for a `-<n>` clash suffix. */
const SUFFIX_ROOM = 6;

export const isReservedTemplateSlug = (slug: string): boolean => SKILL_TEMPLATE_RESERVED_SLUGS.includes(slug);

/** An author-chosen slug: the skill-name shape, and not a reserved word. */
export function validateTemplateSlug(slug: string): string {
  const problem = skillTemplateSlugProblem(slug);
  if (problem) throw new BadRequestError(problem);
  return slug;
}

/** The default slug's stem: the skill name in slug form, short enough to take a suffix. */
export function templateSlugBase(skillName: string): string {
  return claudeSkillNameFor(skillName)
    .slice(0, SKILL_TEMPLATE_SLUG_MAX - SUFFIX_ROOM)
    .replace(/-+$/, '');
}

/** The first of `base`, `base-2`, `base-3`, ... that is neither taken nor reserved. */
export function firstFreeTemplateSlug(base: string, taken: ReadonlySet<string>): string {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(candidate) && !isReservedTemplateSlug(candidate)) return candidate;
  }
}
