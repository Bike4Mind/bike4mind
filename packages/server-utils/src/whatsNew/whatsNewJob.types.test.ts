import { describe, expect, it } from 'vitest';
import { WhatsNewQueueMessageSchema } from './whatsNewJob.types';

const highlights = { correlationId: 'c1', environment: 'production' as const };
const releaseNotes = {
  kind: 'release-notes',
  schemaVersion: 1,
  releaseTag: 'v1.0.0',
  releaseUrl: 'https://example.com/releases/v1.0.0',
  previousTag: null,
  deployedSha: 'abc123',
  deployedAt: '2026-01-01T00:00:00Z',
  prs: [],
};

describe('WhatsNewQueueMessageSchema', () => {
  it('accepts a release-notes body', () => {
    expect(WhatsNewQueueMessageSchema.parse(releaseNotes).kind).toBe('release-notes');
  });

  it('accepts a highlights body with kind', () => {
    expect(WhatsNewQueueMessageSchema.parse({ ...highlights, kind: 'highlights' }).kind).toBe('highlights');
  });

  it('rejects a highlights body without kind', () => {
    expect(WhatsNewQueueMessageSchema.safeParse(highlights).success).toBe(false);
  });

  it('rejects an unknown kind', () => {
    expect(WhatsNewQueueMessageSchema.safeParse({ ...highlights, kind: 'other' }).success).toBe(false);
  });
});
