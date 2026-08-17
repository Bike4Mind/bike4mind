import { z } from 'zod';

// Shared by the request and response schemas below - kept to one definition so the two
// can't quietly diverge on what a tag looks like.
const SessionTagSchema = z.object({ name: z.string(), strength: z.number() });

/**
 * Request schema for PUT /api/sessions/{id}. This is the exact field allowlist
 * sessionService.updateSession enforces (b4m-core/services/src/sessionService/update.ts,
 * which extends this schema with `id`) - shared so the public contract can never
 * document a field the service silently drops, or vice versa.
 */
export const SessionUpdateRequestSchema = z.object({
  // .min(1): the service writes this with `name || session.name`, so an empty string
  // would silently no-op instead of erroring - reject it explicitly at the boundary.
  name: z.string().min(1).optional(),
  // Full replacement list of attached knowledge (fabFile) ids. Setting this together
  // with forceKnowledgeRetrieval: true is what turns on grounded retrieval for the session.
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  tags: z.array(SessionTagSchema).optional(),
  lastUsedModel: z
    .string()
    .min(1)
    .nullish()
    .describe(
      'Pin a specific model id, or omit/send null to leave the current pin unchanged. Sending null does NOT clear it.'
    ),
  // Data Lake mode toggles this on an existing session. surface is intentionally left out
  // (and unchanged) so the chat stays in the main sidebar list. See datalake-in-chat-mode design.
  forceKnowledgeRetrieval: z.boolean().optional(),
  // Defaults to true, matching what every caller did before this flag existed. Pass
  // false when the session gained a file WITHOUT the user asking for it to travel -
  // an upload that lands in notebook context by default has consented to this
  // notebook, not to the whole project. (Mechanics/irreversibility are in .describe()
  // below - that text is what reaches the published spec, this comment isn't.)
  propagateToProjects: z
    .boolean()
    .optional()
    .describe(
      'Defaults to true when omitted. When knowledgeIds grows, the newly-added file ids are also ' +
        'appended to every project that contains this session, granting every member of that project ' +
        'access to those files. This propagation is append-only and cannot be undone through the UI - ' +
        'pass false if newly-attached files should not be shared with the project.'
    ),
});

export type SessionUpdateRequest = z.infer<typeof SessionUpdateRequestSchema>;

/** Path parameter for session-scoped endpoints, e.g. GET/PUT /api/sessions/{id}. */
export const SessionIdParamSchema = z.object({
  id: z.string().min(1),
});

/**
 * Practical response subset for PUT /api/sessions/{id} - the fields a caller needs to
 * confirm an update took effect. ISession (types/entities/SessionTypes.ts) carries many
 * more server-internal fields not documented as public API surface here.
 */
export const SessionResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  userId: z.string(),
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  tags: z.array(SessionTagSchema).optional(),
  forceKnowledgeRetrieval: z.boolean().optional(),
  lastUsedModel: z.string().nullish(),
  // Plain z.date(), not z.coerce.date(): these are always set on a session (ISession has
  // them as required Date fields), and coerce accepts null (Date(null) -> epoch) which
  // zod-to-openapi then renders as a falsely-nullable field in the generated spec.
  firstCreated: z.date(),
  lastUpdated: z.date(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;
