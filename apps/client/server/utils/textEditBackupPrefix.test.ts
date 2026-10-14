import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TEXT_EDIT_BACKUP_PREFIX } from './textEditBackupPrefix';

const repoRoot = resolve(fileURLToPath(import.meta.url), '../../../../..');

// These files cannot import the constant, so a changed prefix would silently stop expiring backups.
const LIFECYCLE_FILES = [
  'infra/buckets.ts',
  'compose.selfhost.yaml',
  'selfhost/kubernetes/files/buckets.sh',
  'scripts/smoke_selfhost_objectstore.py',
];

describe('TEXT_EDIT_BACKUP_PREFIX', () => {
  it.each(LIFECYCLE_FILES)('is the prefix the lifecycle rule in %s expires', file => {
    const source = readFileSync(resolve(repoRoot, file), 'utf8');
    expect(source).toContain(TEXT_EDIT_BACKUP_PREFIX);
  });
});
