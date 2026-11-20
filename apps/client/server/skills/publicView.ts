import type { ISkill, PublicSkill, PublicSkillSummary } from '@bike4mind/common';

/** The /api/v1 skill wire shape (schemas/skillsPublic.ts in @bike4mind/common): an explicit snake_case allowlist. */
const iso = (value: Date | string | undefined): string => (value ? new Date(value).toISOString() : '');

export function toPublicSkillSummary(skill: ISkill, appUrl: string): PublicSkillSummary {
  return {
    id: skill.id,
    url: `${appUrl}/skills/${skill.id}`,
    name: skill.name,
    description: skill.description,
    argument_hint: skill.argumentHint ?? null,
    claude_code_allowed_tools: skill.claudeCodeAllowedTools ?? [],
    ...(skill.claudeCodeModel && { claude_code_model: skill.claudeCodeModel }),
    disable_model_invocation: Boolean(skill.disableModelInvocation),
    scope: skill.isSystem ? 'system' : skill.organizationId ? 'organization' : 'user',
    organization_id: skill.organizationId ?? null,
    file_count: skill.files?.length ?? 0,
    created_at: iso(skill.createdAt),
    updated_at: iso(skill.updatedAt),
  };
}

export function toPublicSkill(skill: ISkill, appUrl: string): PublicSkill {
  return {
    ...toPublicSkillSummary(skill, appUrl),
    body: skill.body,
    allowed_tools: skill.allowedTools ?? [],
    files: (skill.files ?? []).map(({ path, content }) => ({ path, content })),
  };
}
