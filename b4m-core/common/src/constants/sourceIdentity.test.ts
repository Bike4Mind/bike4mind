import { describe, it, expect } from 'vitest';
import { sourceIdentityKeyFor } from './sourceIdentity';

describe('sourceIdentityKeyFor', () => {
  it('prefers driveFileId over every weaker signal', () => {
    const identity = sourceIdentityKeyFor(
      { driveFileId: 'drive-1', relativePath: 'docs/', fileName: 'policy.md' },
      'lake-1'
    );
    expect(identity?.tier).toBe('driveFileId');
    expect(identity?.key).toContain('drive-1');
    // The weaker signals must not reach the key at all, or a Drive file renamed in place would
    // stop matching the generation it replaced.
    expect(identity?.key).not.toContain('policy.md');
  });

  it('falls to relativePath, then to the bare file name', () => {
    expect(sourceIdentityKeyFor({ relativePath: 'docs/', fileName: 'policy.md' }, 'lake-1')?.tier).toBe('relativePath');
    expect(sourceIdentityKeyFor({ fileName: 'policy.md' }, 'lake-1')?.tier).toBe('fileName');
  });

  it('returns null for a file with no usable name, so it matches only itself', () => {
    expect(sourceIdentityKeyFor({}, 'lake-1')).toBeNull();
    // A relativePath alone is NOT an identity: the path is a prefix, and every file directly under
    // one folder would otherwise share a key.
    expect(sourceIdentityKeyFor({ relativePath: 'docs/' }, 'lake-1')).toBeNull();
  });

  it('separates identical files across scopes and across tiers', () => {
    const inLake1 = sourceIdentityKeyFor({ fileName: 'policy.md' }, 'lake-1');
    const inLake2 = sourceIdentityKeyFor({ fileName: 'policy.md' }, 'lake-2');
    expect(inLake1?.key).not.toBe(inLake2?.key);
    // A file NAMED like another file's drive id must not collide with it: the tier literal sits at a
    // fixed position in the key, so neither value can forge the other's.
    const byName = sourceIdentityKeyFor({ fileName: 'drive-1' }, 'lake-1');
    const byDriveId = sourceIdentityKeyFor({ driveFileId: 'drive-1' }, 'lake-1');
    expect(byName?.key).not.toBe(byDriveId?.key);
  });

  it('treats null and undefined alike, since a datastore spells absence both ways', () => {
    expect(sourceIdentityKeyFor({ driveFileId: null, relativePath: null, fileName: 'policy.md' }, 'l')?.tier).toBe(
      'fileName'
    );
    expect(sourceIdentityKeyFor({ fileName: null }, 'l')).toBeNull();
  });
});
