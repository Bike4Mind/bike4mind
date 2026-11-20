import { z } from 'zod';
import { PublicSkillFileSchema } from './skillMarketPublic';

/**
 * Wire schemas for the public Skills authoring contracts (api-contract/contracts/skills.contract.ts).
 * Snake_case allowlist over ISkill; the server mapper is apps/client/server/skills/publicView.ts.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

const ISO = 'ISO 8601 timestamp.';

// Characters, not bytes. Comfortably above the 50,000-character body cap plus any frontmatter.
export const SKILL_MD_MAX_CHARS = 200_000;

/** `id` is a plain string so a malformed id answers 404, not 422 (CONVENTIONS.md status table). */
export const SkillIdParamSchema = z.object({ id: z.string().min(1) });

const skillMdField = z
  .string()
  .min(1)
  .max(SKILL_MD_MAX_CHARS)
  .describe(
    'The full text of a SKILL.md: a YAML frontmatter block (`name`, `description`, and optionally ' +
      '`argument-hint`, `allowed-tools`, `model`, `disable-model-invocation`) followed by the markdown body. ' +
      'The same rules as the Skills page import apply: name in kebab-case up to 64 characters, ' +
      'description up to 500 characters, body up to 50,000 characters.'
  );

const filesField = z
  .record(z.string(), z.string())
  .describe(
    'Supporting text files keyed by path, each under `scripts/` or `references/` (for example ' +
      '`scripts/run.sh`). At most 20 files, 100 KB each and 512 KB in total. `scripts/` files are ' +
      'reviewed by a human before the skill can be published to the Skill Market.'
  );

/** Strict, so a camelCase or unknown field is a 422 rather than silently dropped. */
export const CreateSkillRequestSchema = z
  .object({
    skill_md: skillMdField,
    files: filesField.optional(),
    scope: z
      .object({
        organization_id: z
          .string()
          .min(1)
          .describe('Create the skill for this organization. You must be its owner or a manager.'),
      })
      .strict()
      .optional()
      .describe('Omit for a skill that belongs to you. System skills cannot be created through the API.'),
  })
  .strict();
export type CreateSkillRequest = z.infer<typeof CreateSkillRequestSchema>;

export const UpdateSkillRequestSchema = z
  .object({
    skill_md: skillMdField.describe(
      'The full replacement SKILL.md. Fields the frontmatter leaves out are cleared (`argument-hint`, ' +
        '`allowed-tools`, `model`, `disable-model-invocation`); `name` may be left out to keep the current one.'
    ),
    files: filesField
      .optional()
      .describe('Replaces all supporting files; `{}` removes them. Omit to leave the current files unchanged.'),
    allow_rename: z
      .boolean()
      .optional()
      .describe('Required to apply a `name` that differs from the current one. Otherwise the call is a 409.'),
  })
  .strict();
export type UpdateSkillRequest = z.infer<typeof UpdateSkillRequestSchema>;

export const PublicSkillSummarySchema = z.object({
  id: z.string(),
  url: z.string().describe('The skill in the Bike4Mind app. Publish it with `POST /api/v1/skills/market/listings`.'),
  name: z.string(),
  description: z.string(),
  argument_hint: z.string().nullable(),
  claude_code_allowed_tools: z.array(z.string()).describe('The SKILL.md `allowed-tools`, kept verbatim.'),
  claude_code_model: z
    .string()
    .optional()
    .describe('The SKILL.md `model`, kept verbatim for Claude Code exports. Absent when the SKILL.md sets none.'),
  disable_model_invocation: z.boolean(),
  scope: z.enum(['user', 'organization', 'system']),
  organization_id: z.string().nullable(),
  file_count: z.number().int().describe('Number of supporting files.'),
  created_at: z.string().describe(ISO),
  updated_at: z.string().describe(ISO),
});
export type PublicSkillSummary = z.infer<typeof PublicSkillSummarySchema>;

export const PublicSkillSchema = PublicSkillSummarySchema.extend({
  body: z.string().describe('The SKILL.md body, without the frontmatter.'),
  allowed_tools: z.array(z.string()).describe('Bike4Mind tools the skill is limited to when a model invokes it.'),
  files: z.array(PublicSkillFileSchema).describe('Supporting files, sorted by path.'),
});
export type PublicSkill = z.infer<typeof PublicSkillSchema>;

export const SaveSkillResponseSchema = PublicSkillSchema.extend({
  dropped_fields: z
    .array(z.string())
    .describe('Frontmatter keys that Bike4Mind skills have no field for. They were ignored.'),
});
export type SaveSkillResponse = z.infer<typeof SaveSkillResponseSchema>;

export const MySkillsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).optional(),
  q: z.string().min(1).max(100).optional().describe('Case-insensitive match on name or description.'),
  organization_id: z
    .string()
    .min(1)
    .optional()
    .describe("List this organization's skills instead of your own. You must be its owner or a manager."),
});
export type MySkillsQuery = z.infer<typeof MySkillsQuerySchema>;

export const MySkillsResponseSchema = z.object({
  data: z.array(PublicSkillSummarySchema),
  next_cursor: z.string().nullable(),
});
