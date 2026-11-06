import { z } from 'zod';
import { paginatedResponseSchema } from './pagination';
import { MAX_PROJECT_CREATE_IDS } from './projectPublic';

/**
 * Wire schemas for the public project member, invite and system-prompt sub-resources
 * (api-contract/contracts/projectSharing.contract.ts). The project itself is `ProjectResourceSchema`,
 * which deliberately leaves sharing state and system prompts off; these endpoints are where a caller
 * with the right access reads and changes them.
 *
 * Imported directly (never through the schemas barrel) by the contract and OpenAPI layers, so keep
 * this file free of `@bike4mind/*` imports - the CI spec job loads it without building anything.
 */

/** Must stay in sync with MAX_INVITE_RECIPIENTS in apps/client/types/api.ts. */
export const MAX_PROJECT_INVITE_RECIPIENTS = 25;
/** Must stay in sync with MAX_INVITE_MESSAGE_LENGTH in apps/client/types/api.ts. */
export const MAX_PROJECT_INVITE_MESSAGE_LENGTH = 1000;

/**
 * Ids are plain strings on purpose: a malformed id must answer 404 (CONVENTIONS.md status table),
 * and a path-param schema failure would answer 422.
 */
export const ProjectMemberParamSchema = z.object({
  id: z.string().min(1),
  user_id: z.string().min(1),
});

export const ProjectSystemPromptParamSchema = z.object({
  id: z.string().min(1),
  file_id: z.string().min(1),
});

export const ProjectSystemPromptSchema = z.object({
  file_id: z.string().describe('The file whose text is the prompt.'),
  enabled: z.boolean().describe('Whether chats in the project use this prompt.'),
});
export type ProjectSystemPrompt = z.infer<typeof ProjectSystemPromptSchema>;

/**
 * Not a list endpoint's body (no `data`): a project's prompts compose in this order, so they are
 * returned whole rather than paged by id.
 */
export const ProjectSystemPromptsResponseSchema = z.object({
  system_prompts: z
    .array(ProjectSystemPromptSchema)
    .describe("The project's system prompts after the change, in the order they are applied."),
});
export type ProjectSystemPromptsResponse = z.infer<typeof ProjectSystemPromptsResponseSchema>;

/** Strict, so the SPA route's camelCase `fileIds` is a 422 rather than silently dropped. */
export const AddProjectSystemPromptsRequestSchema = z
  .object({
    file_ids: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_PROJECT_CREATE_IDS)
      .describe('Files to add as system prompts, enabled. Each must be readable by the caller.'),
  })
  .strict();
export type AddProjectSystemPromptsRequest = z.infer<typeof AddProjectSystemPromptsRequestSchema>;

/** An explicit state rather than the SPA route's toggle, so a retried request cannot flip it back. */
export const UpdateProjectSystemPromptRequestSchema = z
  .object({
    enabled: z.boolean(),
  })
  .strict();
export type UpdateProjectSystemPromptRequest = z.infer<typeof UpdateProjectSystemPromptRequestSchema>;

export const PROJECT_INVITE_PERMISSIONS = ['read', 'create', 'update', 'delete', 'share'] as const;

const RecipientListSchema = z
  .array(z.string())
  .describe(
    'Each entry is the address itself when you typed it or it is your own, otherwise the user id of ' +
      'the account it reached (named in `recipient_users`), otherwise a masked address.'
  );

export const ProjectInviteSchema = z.object({
  id: z.string(),
  permissions: z.array(z.enum(PROJECT_INVITE_PERMISSIONS)).describe('What an invitee gets on the project.'),
  recipients: z.object({
    pending: RecipientListSchema,
    accepted: RecipientListSchema,
    refused: RecipientListSchema,
  }),
  recipient_users: z
    .array(z.object({ user_id: z.string(), name: z.string() }))
    .describe('Display names for the user ids listed in `recipients`.'),
  description: z.string().nullable().describe('The message sent with the invite.'),
  link_only: z.boolean().describe('True for a share link that names nobody and anyone holding it can redeem.'),
  uses_remaining: z.number().int().describe('How many more times the invite can be accepted.'),
  expires_at: z.string().nullable().describe('ISO 8601 timestamp, or null for no expiry.'),
  created_at: z.string().nullable().describe('ISO 8601 timestamp.'),
});
export type ProjectInvite = z.infer<typeof ProjectInviteSchema>;

export const ProjectInviteStatusQuerySchema = z.enum(['pending', 'accepted']);

export const ListProjectInvitesResponseSchema = paginatedResponseSchema(ProjectInviteSchema);
export type ListProjectInvitesResponse = z.infer<typeof ListProjectInvitesResponseSchema>;

export const CreatedProjectInviteSchema = ProjectInviteSchema.extend({
  link: z
    .string()
    .describe(
      'The share link. It is a bearer secret: anyone holding it can accept while uses remain. It is ' +
        'returned only here, never by the list.'
    ),
});
export type CreatedProjectInvite = z.infer<typeof CreatedProjectInviteSchema>;

/**
 * Strict, so a camelCase `expiresAt` is a 422 rather than silently creating an invite that never
 * expires.
 */
export const CreateProjectInviteRequestSchema = z
  .object({
    permissions: z.array(z.enum(PROJECT_INVITE_PERMISSIONS)).min(1).describe('What an invitee gets on the project.'),
    recipients: z
      .array(z.string().min(1))
      .max(MAX_PROJECT_INVITE_RECIPIENTS)
      .optional()
      .describe(
        'Email addresses, usernames or user ids to invite. Each is emailed a link. Omit it, or send an ' +
          'empty list, for a share link that names nobody.'
      ),
    description: z
      .string()
      .max(MAX_PROJECT_INVITE_MESSAGE_LENGTH)
      .optional()
      .describe('A message included in the invite email.'),
    expires_at: z.iso.datetime({ offset: true }).optional().describe('ISO 8601 timestamp in the future.'),
  })
  .strict();
export type CreateProjectInviteRequest = z.infer<typeof CreateProjectInviteRequestSchema>;
