import { describe, it, expect } from 'vitest';
import { NotebookExportRequestSchema } from './api';

const HEX = '507f1f77bcf86cd799439011';

describe('NotebookExportRequestSchema - notebookIds', () => {
  it('accepts a request that names no notebooks', () => {
    expect(NotebookExportRequestSchema.parse({}).notebookIds).toBeUndefined();
  });

  it('accepts a stringified ObjectId in either hex case', () => {
    const parsed = NotebookExportRequestSchema.parse({ notebookIds: [HEX, HEX.toUpperCase()] });
    expect(parsed.notebookIds).toEqual([HEX, HEX.toUpperCase()]);
  });

  it('rejects an id that cannot address a notebook, rather than letting Mongo throw', () => {
    // SessionModel is ObjectId-keyed and the service puts these straight into `_id: { $in: ... }`,
    // so an unguarded value fails the whole export with a 500 that names nothing actionable.
    expect(() => NotebookExportRequestSchema.parse({ notebookIds: ['not-an-objectid'] })).toThrow();
  });

  it('rejects an optimistic client id, which is what a real caller would send too early', () => {
    // createOptimisticSessionId() mints these, and a notebook carries one until the server id lands.
    expect(() =>
      NotebookExportRequestSchema.parse({ notebookIds: [`optimistic-session-${'a'.repeat(36)}`] })
    ).toThrow();
  });

  it('rejects one bad id among good ones and names it, so a batch cannot half-succeed', () => {
    const result = NotebookExportRequestSchema.safeParse({ notebookIds: [HEX, 'not-an-objectid'] });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].path.join('.')).toBe('notebookIds.1');
    }
  });
});
