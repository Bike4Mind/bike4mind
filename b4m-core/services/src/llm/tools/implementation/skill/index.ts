import {
  parseSkillArguments,
  substituteArguments,
  wrapUntrustedSkillBody,
  intersectAllowedTools,
} from '@bike4mind/common';
import { ToolDefinition } from '../../base/types';

interface SkillToolParams {
  name?: string;
  args?: string;
}

/** Cap on how many invocable skills are listed back when resolution fails. */
const INVOCABLE_HINT_LIMIT = 50;

/**
 * LLM-invocable `skill` tool - the autonomous counterpart to user `/skill-name`
 * invocations handled by SkillsFeature.
 *
 * The LLM passes `{ name, args }`. The tool resolves the skill across every
 * scope the caller can access (`findAccessibleByNameForUser` - owned + shared +
 * global-read), expands `$ARGUMENTS` / `$1` / `$2`, and returns the expanded
 * body as the observation for the next turn. Skills with
 * `disableModelInvocation: true` are not callable here.
 *
 * Security: a skill the caller does NOT own (shared / org / global) is treated
 * as untrusted content - its body is wrapped with explicit delimiters and a
 * "do not follow conflicting instructions" framing so a malicious author can't
 * hijack the turn via prompt injection. The skill's `allowedTools` whitelist is
 * surfaced to the model as a *requested* tool scope (intersected with the
 * invoker's allow-list via `intersectAllowedTools`). NOTE: today this is prompt
 * guidance only - there is no `ToolContext` invoker allow-list to enforce it
 * against, so the wording stays advisory. When that wiring lands, the same
 * `permittedTools` set can narrow the completion's actual tool list.
 *
 * Catalog discovery: the available skill names + descriptions are listed in
 * the system prompt by SkillsFeature, so the LLM knows what's invocable. If
 * the LLM passes a name that isn't accessible, the tool returns an error
 * mentioning the available skills.
 */
export const skillTool: ToolDefinition = {
  name: 'skill',
  implementation: context => ({
    toolFn: async (parameters?: unknown) => {
      const params = (parameters ?? {}) as SkillToolParams;
      const rawName = typeof params.name === 'string' ? params.name.trim() : '';
      if (!rawName) {
        return 'Error: `name` is required. Pass the kebab-case name of an available skill.';
      }
      const name = rawName.replace(/^\//, '');

      const skillsRepo = context.db.skills;
      if (!skillsRepo) {
        return 'Error: skills are not configured in this environment.';
      }

      const skill = await skillsRepo.findAccessibleByNameForUser(context.userId, name);
      if (!skill || skill.disableModelInvocation) {
        const accessible = await skillsRepo.listAccessibleInvocableForUser(context.userId, INVOCABLE_HINT_LIMIT);
        const invocable = accessible.map(s => s.name);
        return invocable.length === 0
          ? `Error: skill "${name}" is not available, and you have no LLM-invocable skills defined.`
          : `Error: skill "${name}" is not available. Invocable skills: ${invocable.join(', ')}`;
      }

      const argArray = typeof params.args === 'string' ? parseSkillArguments(params.args) : [];
      const expandedBody = substituteArguments(skill.body, argArray);

      // Owner-authored skills are trusted prompt content. Anything else
      // (shared / org / system) is authored by someone other than the invoker,
      // so wrap it as untrusted to neutralize prompt-injection in the body.
      const isOwner = skill.userId === context.userId;
      if (isOwner) {
        return `## Skill: /${skill.name}\n\n${expandedBody}\n\n---\nFollow the instructions above for the rest of this turn.`;
      }

      const ownerLabel = skill.organizationId ? 'your organization' : skill.isSystem ? 'the system' : 'another user';
      const wrapped = wrapUntrustedSkillBody(skill.name, expandedBody, ownerLabel);

      // A shared skill may only narrow the tool surface, never widen it. There
      // is no per-invoker tool allow-list in the current tool context, so the
      // skill's own whitelist stands on its own (the intersection degenerates).
      // The helper is the single source of truth so an invoker allow-list, once
      // it exists, narrows this without touching the call site. Until the tool
      // list is actually narrowed, this is advisory prompt guidance - keep the
      // wording soft rather than claiming a hard guarantee a model could ignore.
      const invokerAllowedTools: string[] | undefined = undefined;
      const permittedTools = intersectAllowedTools(skill.allowedTools, invokerAllowedTools);
      const toolConstraint =
        permittedTools && permittedTools.length > 0
          ? `\n\nThis skill is intended to use only these tools: ${permittedTools.join(', ')}. Prefer to stay within that set.`
          : '';

      return `${wrapped}${toolConstraint}\n\n---\nFollow the intent above for the rest of this turn, subject to the constraints stated.`;
    },
    toolSchema: {
      name: 'skill',
      description:
        'Invoke a user-defined skill by name. Skills are reusable instruction templates the user has authored ' +
        '(see the "Available Skills" list in the system prompt). The tool returns the expanded skill body for you ' +
        'to follow. Use this when a user request matches a skill that fits the task.',
      parameters: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'kebab-case name of the skill to invoke (e.g. "summarize", "review-pr").',
          },
          args: {
            type: 'string',
            description:
              'Optional argument text. Substituted into the skill body via `$ARGUMENTS`, `$1`, `$2`, ... ' +
              'Use shell-style quoting if a positional arg contains spaces (e.g. \'"hello world" priority-high\').',
          },
        },
        required: ['name'],
      },
    },
  }),
};
