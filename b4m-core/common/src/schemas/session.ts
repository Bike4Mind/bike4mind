import { z } from 'zod';

/**
 * Request schema for PUT /api/sessions/{id}. This is the exact field allowlist
 * sessionService.updateSession enforces (b4m-core/services/src/sessionService/update.ts,
 * which extends this schema with `id`) - shared so the public contract can never
 * document a field the service silently drops, or vice versa.
 */
// Shared by the request and response schemas below - kept to one definition so the two
// can't quietly diverge on what a tag looks like.
const SessionTagSchema = z.object({ name: z.string(), strength: z.number() });

export const SessionUpdateRequestSchema = z.object({
  name: z.string().optional(),
  // Full replacement list of attached knowledge (fabFile) ids. Setting this together
  // with forceKnowledgeRetrieval: true is what turns on grounded retrieval for the session.
  knowledgeIds: z.array(z.string()).optional(),
  artifactIds: z.array(z.string()).optional(),
  tags: z.array(SessionTagSchema).optional(),
  // `.describe()` is a plain Zod method (unlike `.openapi()`, it needs no registry
  // extension), so it is safe to call in a shared schema file and zod-to-openapi
  // picks it up as the field's spec description automatically.
  lastUsedModel: z
    .string()
    .nullish()
    .describe(
      'Pin a specific model id, or omit/send null to leave the current pin unchanged. Sending null does NOT clear it.'
    ),
  // Data Lake mode toggles this on an existing session. surface is intentionally left out
  // (and unchanged) so the chat stays in the main sidebar list. See datalake-in-chat-mode design.
  forceKnowledgeRetrieval: z.boolean().optional(),
  /**
   * Whether newly-added knowledgeIds should also be appended to every project that
   * contains this session (and shared with that project's members).
   *
   * Defaults to true, which is what every deliberate "add this file" gesture wants and
   * what all callers did before this flag existed. Pass false when the session gained a
   * file WITHOUT the user asking for it to travel - an upload that lands in notebook
   * context by default has consented to this notebook, not to the whole project. The
   * propagation is append-only (nothing ever removes a fileId from a project), so a
   * wrong `true` is not recoverable through the UI.
   */
  propagateToProjects: z.boolean().optional(),
});

export type SessionUpdateRequest = z.infer<typeof SessionUpdateRequestSchema>;

/** Path parameter for session-scoped endpoints, e.g. GET/PUT /api/sessions/{id}. */
export const SessionIdParamSchema = z.object({
  id: z.string(),
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
