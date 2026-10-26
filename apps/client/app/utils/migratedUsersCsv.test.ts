import Papa from 'papaparse';
import { describe, expect, it } from 'vitest';
import { buildMigratedUsersCsv } from './migratedUsersCsv';

describe('buildMigratedUsersCsv', () => {
  it('round-trips a password that starts with a formula character', () => {
    const csv = buildMigratedUsersCsv([{ name: '=Ada', email: 'a@x.io', tempPassword: '-Ab1=x' }]);
    expect(Papa.parse<string[]>(csv).data[1]).toEqual(["'=Ada", 'a@x.io', '-Ab1=x']);
  });

  it('keeps a password with a newline or quote unchanged', () => {
    const csv = buildMigratedUsersCsv([{ name: 'Ada', email: 'a@x.io', tempPassword: 'a"b\nc' }]);
    expect(Papa.parse<string[]>(csv).data[1][2]).toBe('a"b\nc');
  });

  it('omits the password column when there is no password', () => {
    expect(buildMigratedUsersCsv([{ name: 'Ada', email: 'a@x.io' }])).toBe('"Name","Email"\n"Ada","a@x.io"');
  });
});
