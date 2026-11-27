// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { SessionResponseSchema, type ISessionDocument } from '@bike4mind/common';
import { toPublicSession } from './toPublicSession';

describe('toPublicSession', () => {
  // A field the schema publishes but the allowlist never copies is silently absent on every v1
  // session response, so the two key sets are pinned to each other.
  it('emits exactly the fields SessionResponseSchema publishes', () => {
    const session = {
      id: '65c000000000000000000001',
      name: 'Notebook',
      userId: 'u1',
      organizationId: '65c000000000000000000002',
      knowledgeIds: [],
      artifactIds: [],
      tags: [{ name: 't', strength: 1 }],
      forceKnowledgeRetrieval: false,
      retrievalTags: [],
      lakeScopeExplicit: true,
      includeLibraryFiles: true,
      promptCacheTtl: '1h',
      lastUsedModel: 'model',
      firstCreated: new Date('2026-01-01T00:00:00Z'),
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
      systemPromptText: 'never published',
    } as unknown as ISessionDocument;

    const output = toPublicSession(session);

    // deletedAt is only emitted on a tombstone (see the next test).
    expect(Object.keys(output).sort()).toEqual(
      Object.keys(SessionResponseSchema.shape)
        .filter(key => key !== 'deletedAt')
        .sort()
    );
    expect(output.organizationId).toBe(session.organizationId);
    expect(SessionResponseSchema.safeParse(output).success).toBe(true);
  });

  it('emits deletedAt only for a soft-deleted session', () => {
    const deletedAt = new Date('2026-01-03T00:00:00Z');
    const session = {
      id: '65c000000000000000000001',
      name: 'Notebook',
      userId: 'u1',
      firstCreated: new Date('2026-01-01T00:00:00Z'),
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
      updatedAt: deletedAt,
      deletedAt,
    } as unknown as ISessionDocument;

    const output = toPublicSession(session);

    expect(output.deletedAt).toEqual(deletedAt);
    expect(output.updatedAt).toEqual(deletedAt);
  });
});
