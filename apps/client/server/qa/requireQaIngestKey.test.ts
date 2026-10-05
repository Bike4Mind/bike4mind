import { describe, it, expect } from 'vitest';
import { ApiKeyScope, QA_INGEST_USER_TAG } from '@bike4mind/common';
import { requireQaIngestKey } from './requireQaIngestKey';

const tagged = { tags: [QA_INGEST_USER_TAG] };

describe('requireQaIngestKey', () => {
  it('401s a JWT caller (no API key)', () => {
    expect(() => requireQaIngestKey({ user: tagged })).toThrow(expect.objectContaining({ statusCode: 401 }));
  });
  it('403s a key without qa:ingest', () => {
    expect(() => requireQaIngestKey({ apiKeyInfo: { scopes: [ApiKeyScope.AI_CHAT] }, user: tagged })).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });
  it('403s a qa:ingest key whose owner lacks the tag', () => {
    expect(() => requireQaIngestKey({ apiKeyInfo: { scopes: [ApiKeyScope.QA_INGEST] }, user: { tags: [] } })).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });
  it('403s when the owner has null tags', () => {
    expect(() => requireQaIngestKey({ apiKeyInfo: { scopes: [ApiKeyScope.QA_INGEST] }, user: { tags: null } })).toThrow(
      expect.objectContaining({ statusCode: 403 })
    );
  });
  it('passes a tagged qa:ingest key', () => {
    expect(() => requireQaIngestKey({ apiKeyInfo: { scopes: [ApiKeyScope.QA_INGEST] }, user: tagged })).not.toThrow();
  });
});
