import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMigrationWithId, formatMigrationId } from './migrationId';

describe('formatMigrationId', () => {
  it('stamps the UTC time, not the local time', () => {
    expect(formatMigrationId(new Date('2026-11-12T23:04:05.678Z'))).toBe('20261112230405');
  });
});

describe('findMigrationWithId', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'migration-id-'));
    fs.writeFileSync(path.join(dir, '20261112230405_add-field.ts'), '');
    fs.writeFileSync(path.join(dir, '20261112230406-other.ts'), '');
    fs.writeFileSync(path.join(dir, 'index.ts'), '');
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('finds a file that already uses the id, whatever its slug or separator', () => {
    expect(findMigrationWithId(dir, '20261112230405')).toBe('20261112230405_add-field.ts');
    expect(findMigrationWithId(dir, '20261112230406')).toBe('20261112230406-other.ts');
  });

  it('does not match an id that is only a prefix of another', () => {
    expect(findMigrationWithId(dir, '2026111223040')).toBeUndefined();
  });

  it('returns undefined for an unused id', () => {
    expect(findMigrationWithId(dir, '20261112230407')).toBeUndefined();
  });
});
