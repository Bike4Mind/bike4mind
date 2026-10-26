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
      knowledgeIds: [],
      artifactIds: [],
      tags: [{ name: 't', strength: 1 }],
      forceKnowledgeRetrieval: false,
      retrievalTags: [],
      lakeScopeExplicit: true,
      includeLibraryFiles: true,
      lastUsedModel: 'model',
      firstCreated: new Date('2026-01-01T00:00:00Z'),
      lastUpdated: new Date('2026-01-02T00:00:00Z'),
      systemPromptText: 'never published',
    } as unknown as ISessionDocument;

    const output = toPublicSession(session);

    expect(Object.keys(output).sort()).toEqual(Object.keys(SessionResponseSchema.shape).sort());
    expect(SessionResponseSchema.safeParse(output).success).toBe(true);
  });
});
