import { describe, it, expect } from 'vitest';
import { QuestStartBodySchema } from './questStartBody';

const body = {
  userId: 'u1',
  sessionId: 's1',
  questId: 'q1',
  message: 'hello',
  messageFileIds: [],
  historyCount: 0,
  fabFileIds: [],
  params: { model: 'gpt-4' },
  promptMeta: {},
  queryComplexity: 'simple',
};

describe('QuestStartBodySchema.authOrigin', () => {
  it('keeps the origin the door set', () => {
    expect(QuestStartBodySchema.parse({ ...body, authOrigin: 'apiKey', apiKeyId: 'k1' }).authOrigin).toBe('apiKey');
  });

  // A message queued before the field existed must not read as a signed-in session.
  it('fails a body with no origin closed to internal', () => {
    expect(QuestStartBodySchema.parse(body).authOrigin).toBe('internal');
  });

  it('keeps a legacy key body a key turn', () => {
    expect(QuestStartBodySchema.parse({ ...body, apiKeyId: 'k1' }).authOrigin).toBe('apiKey');
  });

  it('rejects an unknown origin', () => {
    expect(() => QuestStartBodySchema.parse({ ...body, authOrigin: 'admin' })).toThrow();
  });
});

// Carried through the queue: a field the schema strips would reach the worker as "integrations on".
describe('QuestStartBodySchema.disableUserIntegrations', () => {
  it('keeps the flag the caller set', () => {
    expect(QuestStartBodySchema.parse({ ...body, disableUserIntegrations: true }).disableUserIntegrations).toBe(true);
  });
});
