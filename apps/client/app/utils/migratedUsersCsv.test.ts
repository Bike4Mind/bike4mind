import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { buildMigratedUsersCsv } from './migratedUsersCsv';

describe('buildMigratedUsersCsv', () => {
  it('writes a Name, Email header and formula-escapes the cells', () => {
    const csv = buildMigratedUsersCsv([{ name: '=Ada', email: 'a@x.io' }]);
    expect(Papa.parse<string[]>(csv).data).toEqual([
      ['Name', 'Email'],
      ["'=Ada", 'a@x.io'],
    ]);
  });

  it('has no extra cell beyond the two columns', () => {
    expect(buildMigratedUsersCsv([{ name: 'Ada', email: 'a@x.io' }])).toBe('"Name","Email"\n"Ada","a@x.io"');
  });
});
