import { z } from 'zod';
import { b4mLLMTools } from './llm';

// Briefcase prompt validation
//
// Validation contracts for the briefcase capability: the stored prompt shape
// (for personal-prompt authoring), and the batched catalog request. The catalog
// batch is bounded and all-or-nothing by contract - see the briefcase blueprint.

/** Delivery modes. 'hidden' is reserved (see ExecutionMode in BriefcasePromptTypes). */
export const ExecutionModeSchema = z.enum(['inject', 'auto-fire', 'hidden']);
export type ExecutionModeType = z.infer<typeof ExecutionModeSchema>;

/**
 * Modes acceptable at AUTHORING time. 'hidden' is intentionally excluded until
 * the host has true hidden-send support - accepting it would persist a value
 * that silently behaves as 'auto-fire' (a surprising downgrade). It stays in
 * ExecutionModeSchema/the stored enum for forward-compat.
 */
export const AuthorableExecutionModeSchema = z.enum(['inject', 'auto-fire']);

/**
 * Tools a prompt may require - constrained to the host's closed tool set, MINUS
 * integration-gated tools that act on the caller's own credentials/account. A
 * shared system prompt must not be able to inject e.g. blog-publishing into a
 * non-author's session via requiredTools. (Per-user entitlement of the remaining
 * tools is still the chat pipeline's responsibility - see follow-up note in the
 * briefcase blueprint; this allowlist is the storage-layer floor.)
 */
export const BRIEFCASE_DISALLOWED_TOOLS = ['blog_publish', 'blog_edit', 'blog_draft'] as const;

export const BriefcaseRequiredToolsSchema = z
  .array(
    b4mLLMTools.refine(
      t => !(BRIEFCASE_DISALLOWED_TOOLS as readonly string[]).includes(t),
      'This tool is not permitted in a briefcase prompt'
    )
  )
  .max(16);

/** A 24-char hex Mongo ObjectId string (for by-id refetch and personal CRUD). */
export const BriefcasePromptIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid prompt id');

const PROMPT_TEXT_MAX = 16_000;
const TAGS_MAX = 20;
const VISIBILITY_SCOPES_MAX = 20;

/**
 * Input for creating/updating a PERSONAL prompt. `userId` is intentionally NOT
 * accepted from the body - the service binds ownership to the authenticated
 * caller. System-prompt authoring (visibilityScopes) is not exposed here.
 */
export const BriefcasePromptInput = z.object({
  type: z.string().min(1).max(100),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  promptText: z.string().min(1).max(PROMPT_TEXT_MAX),
  tags: z.array(z.string().min(1).max(50)).max(TAGS_MAX).optional(),
  executionMode: AuthorableExecutionModeSchema.optional(),
  requiredTools: BriefcaseRequiredToolsSchema.optional(),
});
export type BriefcasePromptInputType = z.infer<typeof BriefcasePromptInput>;

/** Partial update of a personal prompt. */
export const BriefcasePromptUpdateInput = BriefcasePromptInput.partial();
export type BriefcasePromptUpdateInputType = z.infer<typeof BriefcasePromptUpdateInput>;

// Batched catalog request

export const MAX_BATCH_QUERIES = 32;
/** Per-sub-query result cap, so a large category can't return an unbounded list. */
export const CATALOG_SUBQUERY_LIMIT = 50;

/**
 * One catalog sub-query. Exactly one selector is used, in precedence order:
 * `personal` (resolved to the caller server-side) > `tags` > `type`.
 */
export const PromptBatchQuerySchema = z.object({
  key: z.string().min(1).max(100),
  tags: z.array(z.string().min(1).max(50)).max(TAGS_MAX).optional(),
  type: z.string().max(100).optional(),
  personal: z.boolean().optional(),
});
export type PromptBatchQueryType = z.infer<typeof PromptBatchQuerySchema>;

/**
 * The batched catalog request. Bounded to MAX_BATCH_QUERIES, and keys must be
 * unique (the response is a key -> prompts map). All-or-nothing by contract.
 */
export const BriefcaseBatchRequestSchema = z.object({
  queries: z
    .array(PromptBatchQuerySchema)
    .min(1)
    .max(MAX_BATCH_QUERIES)
    .refine(qs => new Set(qs.map(q => q.key)).size === qs.length, {
      message: 'Batch query keys must be unique',
    }),
});
export type BriefcaseBatchRequestType = z.infer<typeof BriefcaseBatchRequestSchema>;

export { VISIBILITY_SCOPES_MAX };
