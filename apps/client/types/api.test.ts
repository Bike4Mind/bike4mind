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

  it('rejects an empty array, which the service would otherwise read as "export everything"', () => {
    // `getSessionsToExport` only adds the `_id` filter when the array is non-empty, so `[]` and an
    // omitted field issue the same bare `{ userId }` query. Naming zero notebooks must not return
    // all of them; omitting the field remains the way to ask for everything.
    expect(NotebookExportRequestSchema.safeParse({ notebookIds: [] }).success).toBe(false);
  });

  it('accepts the date-only value an <input type="date"> produces', () => {
    // The export modal's Date Range sends "2026-01-15"; a datetime-only schema 400d every date a
    // user could pick, and the toast named none of it.
    const parsed = NotebookExportRequestSchema.parse({ fromDate: '2026-01-15', toDate: '2026-01-20' });
    expect(parsed.fromDate).toBe('2026-01-15');
    expect(parsed.toDate).toBe('2026-01-20');
  });

  it('still accepts a full ISO datetime, so existing API callers are unaffected', () => {
    const parsed = NotebookExportRequestSchema.parse({ fromDate: '2026-01-15T08:30:00Z' });
    expect(parsed.fromDate).toBe('2026-01-15T08:30:00Z');
  });

  it('still rejects a date that is neither form', () => {
    expect(NotebookExportRequestSchema.safeParse({ fromDate: '15/01/2026' }).success).toBe(false);
  });

  it('caps the batch at 50, matching the sibling curate schema', () => {
    const ids = Array.from({ length: 51 }, () => HEX);
    expect(NotebookExportRequestSchema.safeParse({ notebookIds: ids }).success).toBe(false);
    expect(NotebookExportRequestSchema.safeParse({ notebookIds: ids.slice(0, 50) }).success).toBe(true);
  });
});
