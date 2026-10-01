import { describe, it, expect, vi } from 'vitest';
import type { IDataLakeDocument } from '@bike4mind/common';
import { countNotServingNamedLakes } from './countNotServingNamedLakes';

const lake = (datalakeTag: string, status: IDataLakeDocument['status'], createdByUserId: string) =>
  ({ datalakeTag, status, createdByUserId }) as IDataLakeDocument;

const repo = (lakes: IDataLakeDocument[]) => ({
  findByDatalakeTag: vi.fn(async (tag: string) => lakes.find(l => l.datalakeTag === tag) ?? null),
});

describe('countNotServingNamedLakes', () => {
  it('counts a draft the caller created', async () => {
    const db = repo([lake('datalake:mine', 'draft', 'user-1')]);
    expect(await countNotServingNamedLakes(db, 'user-1', ['datalake:mine'])).toBe(1);
  });

  it("does not count another user's draft, so a named tag cannot probe for it", async () => {
    const db = repo([lake('datalake:theirs', 'draft', 'user-2')]);
    expect(await countNotServingNamedLakes(db, 'user-1', ['datalake:theirs'])).toBe(0);
  });

  it('does not count an active lake that is missing for another reason (gated)', async () => {
    const db = repo([lake('datalake:gated', 'active', 'user-1')]);
    expect(await countNotServingNamedLakes(db, 'user-1', ['datalake:gated'])).toBe(0);
  });

  it('does not count an archived lake (a separate reason, not modelled yet)', async () => {
    const db = repo([lake('datalake:old', 'archived', 'user-1')]);
    expect(await countNotServingNamedLakes(db, 'user-1', ['datalake:old'])).toBe(0);
  });

  it('does not count a tag that resolves to no lake', async () => {
    expect(await countNotServingNamedLakes(repo([]), 'user-1', ['datalake:ghost'])).toBe(0);
  });

  it('matches an ObjectId-like caller id by its string form', async () => {
    const db = repo([lake('datalake:mine', 'draft', 'abc123')]);
    expect(await countNotServingNamedLakes(db, { toString: () => 'abc123' }, ['datalake:mine'])).toBe(1);
  });

  it('records a measured zero without a read when nothing is missing', async () => {
    const db = repo([]);
    expect(await countNotServingNamedLakes(db, 'user-1', [])).toBe(0);
    expect(db.findByDatalakeTag).not.toHaveBeenCalled();
  });

  it('reports unknown, not zero, when the lookup is not wired', async () => {
    expect(await countNotServingNamedLakes(undefined, 'user-1', ['datalake:mine'])).toBeUndefined();
  });

  it('reports unknown, not zero, and warns when the lookup throws', async () => {
    const logger = { warn: vi.fn() };
    const db = { findByDatalakeTag: vi.fn().mockRejectedValue(new Error('boom')) };
    expect(await countNotServingNamedLakes(db, 'user-1', ['datalake:mine'], logger)).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });
});
