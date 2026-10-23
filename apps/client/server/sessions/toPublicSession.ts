import { redactSessionForClient, type ISessionDocument, type SessionResponse } from '@bike4mind/common';

/**
 * Explicit allowlist onto the public SessionResponse shape. Redaction already strips the
 * server-owned fields; the allowlist additionally keeps every undocumented internal field off
 * the wire, so a new ISession field is private until someone adds it here and to the schema.
 */
export function toPublicSession(session: ISessionDocument): SessionResponse {
  const redacted = redactSessionForClient(session);
  return {
    id: redacted.id,
    _id: redacted.id,
    name: redacted.name,
    userId: redacted.userId,
    knowledgeIds: redacted.knowledgeIds,
    artifactIds: redacted.artifactIds,
    tags: redacted.tags?.map(({ name, strength }) => ({ name, strength })),
    forceKnowledgeRetrieval: redacted.forceKnowledgeRetrieval,
    retrievalTags: redacted.retrievalTags,
    lakeScopeExplicit: redacted.lakeScopeExplicit,
    lastUsedModel: redacted.lastUsedModel,
    firstCreated: redacted.firstCreated,
    lastUpdated: redacted.lastUpdated,
  };
}
