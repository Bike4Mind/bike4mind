import { describe, expect, it } from 'vitest';
import { DelegationSchema } from '@bike4mind/common';
import type { IDelegatedItem } from '@bike4mind/database';
import { serializeDelegation } from './serializeDelegation';

const item = (overrides: Partial<IDelegatedItem> = {}) =>
  ({
    _id: { toString: () => 'g1' },
    userId: 'u1',
    intent: 'Summarize',
    url: 'https://example.com/r',
    text: null,
    fileIds: ['f1'],
    status: 'pending',
    result: null,
    failureReason: null,
    model: null,
    settledAt: null,
    briefedAt: null,
    createdAt: new Date('2026-11-19T00:00:00Z'),
    updatedAt: new Date('2026-11-19T00:00:00Z'),
    ...overrides,
  }) as unknown as IDelegatedItem;

describe('serializeDelegation', () => {
  it('produces the public shape of a pending item and hides internal fields', () => {
    const wire = serializeDelegation(item({ failureReason: 'secret', model: 'internal-model' }));
    expect(DelegationSchema.parse(wire)).toEqual(wire);
    expect(wire).toEqual({
      id: 'g1',
      status: 'pending',
      intent: 'Summarize',
      url: 'https://example.com/r',
      text: null,
      file_ids: ['f1'],
      result: null,
      created_at: '2026-11-19T00:00:00.000Z',
      settled_at: null,
    });
  });

  it('carries the outcome of a settled item', () => {
    const settledAt = new Date('2026-11-19T00:01:00Z');
    const wire = serializeDelegation(item({ status: 'handled', result: 'Done.', settledAt }));
    expect(wire).toMatchObject({ status: 'handled', result: 'Done.', settled_at: '2026-11-19T00:01:00.000Z' });
  });
});
