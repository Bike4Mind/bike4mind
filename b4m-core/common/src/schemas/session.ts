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
  // Not shape-checked on purpose: callers echo the stored list back (a rename PUTs the whole
  // session), so a legacy entry must not block an unrelated write. updateSession drops unusable
  // ids instead - see services/src/utils/objectIds.ts for why dropping beats rejecting.
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
  // The active lake set. Tri-state on ONE field rather than exposing the stored
  // `lakeScopeExplicit` sidecar: a caller who sent `[]` and forgot the flag would get the exact
  // OPPOSITE of what they asked for (every lake instead of none), which is not a contract to hand
  // anyone. updateSession derives the sidecar from which of the three arms this is.
  //
  // Deliberately unlike `lastUsedModel` above, where null means "leave unchanged": that field
  // carries a legacy accommodation for callers echoing a whole session back, and there is no
  // other way to spell "clear the scope" here, since `[]` already means "ground on nothing".
  //
  // Not access-checked at this boundary on purpose - resolveLakeMemoryScope intersects these
  // against the caller's entitled tags at retrieval time, so an unreachable tag narrows the
  // scope rather than widening it, and rejecting it here would break the ordinary case of a
  // caller echoing back a scope it has since lost one lake of.
  retrievalTags: z
    .array(z.string())
    .nullable()
    .optional()
    .describe(
      'The data lakes this session grounds on, as lake tags (the `datalakeTag` of each lake from ' +
        'GET /api/data-lakes). Send a list to ground only on those lakes, `[]` to ground on no ' +
        'lake at all, or `null` to clear the choice so retrieval falls back to every lake you can ' +
        'reach. Omit to leave the current choice unchanged. Tags naming a lake you cannot reach ' +
        'are ignored at retrieval time rather than rejected here. Narrowing the scope does not by ' +
        'itself turn retrieval on: pair it with `forceKnowledgeRetrieval: true` for a session that ' +
        'is not already grounded.'
    ),
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
  // Both halves of the lake scope, because `retrievalTags` alone cannot be read back: Mongoose
  // hydrates an unset array to [], so "grounds on no lake" and "never chose" are the same value
  // on the wire. `lakeScopeExplicit` is what separates them, and a caller confirming a write
  // needs the same distinction the retrieval path uses (see resolveLakeMemoryScope).
  retrievalTags: z.array(z.string()).optional(),
  lakeScopeExplicit: z
    .boolean()
    .optional()
    .describe('True when `retrievalTags` is a deliberate choice, so an empty list means "no lake" rather than "any".'),
  lastUsedModel: z.string().nullish(),
  // Plain z.date(), not z.coerce.date(): these are always set on a session (ISession has
  // them as required Date fields), and coerce accepts null (Date(null) -> epoch) which
  // zod-to-openapi then renders as a falsely-nullable field in the generated spec.
  firstCreated: z.date(),
  lastUpdated: z.date(),
});

export type SessionResponse = z.infer<typeof SessionResponseSchema>;
