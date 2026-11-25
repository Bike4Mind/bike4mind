import { describe, it, expect, vi } from 'vitest';
const createIndexes = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('@bike4mind/database', () => ({ AdminAuditLogModel: { createIndexes } }));
import migration from './20260921240085_ensure-feedback-history-index';
describe('feedback history index migration', () => {
  it('builds the schema indexes on deployed databases', async () => {
    await migration.up();
    expect(createIndexes).toHaveBeenCalledTimes(1);
  });

  it('sorts below the fail-closed backfill', () => {
    expect(migration.id).toBeLessThan(20260922000001);
  });
});
