import { describe, it, expect, vi } from 'vitest';

vi.mock('./core.generated', () => ({ coreMigrations: [] }));
vi.mock('./premium.generated', () => ({ premiumMigrations: [] }));

describe('AvailableMigrations with an empty generated core registry', () => {
  it('refuses to load instead of reporting nothing pending', async () => {
    await expect(import('./index')).rejects.toThrow(/registers no core migrations/);
  });
});
