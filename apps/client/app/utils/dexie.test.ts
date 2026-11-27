import { describe, expect, it } from 'vitest';
import { DexieStore } from './dexie';

describe('DexieStore schema', () => {
  it('declares a version that drops the retired questmasterplans cache', () => {
    const db = new DexieStore();

    expect(db.verno).toBe(22);
    expect(db.tables.map(t => t.name)).not.toContain('questmasterplans');
    expect(db.tables.map(t => t.name)).toContain('quests');
  });
});
