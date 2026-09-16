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

  // Regression (QA on #2238): the lake wizard's flat "Upload Files..." picker sets
  // relativePath = webkitRelativePath || file.name (folderTreeParser.ts), so an ordinary
  // single-file upload arrives carrying its own bare name as a "path". That is not folder
  // evidence, and treating it as such both overstated the tier and split one document's
  // generations across two key spaces.
  it('ignores a relativePath that carries no folder, since the flat picker fills it with the file name', () => {
    const flatPicked = sourceIdentityKeyFor({ relativePath: 'policy.md', fileName: 'policy.md' }, 'lake-1');
    expect(flatPicked?.tier).toBe('fileName');
    // Same key as an upload door that sets no relativePath at all (chat attach), or two
    // generations of one document admitted through different doors never group together.
    expect(flatPicked?.key).toBe(sourceIdentityKeyFor({ fileName: 'policy.md' }, 'lake-1')?.key);
  });

  it('keys the relativePath tier on the folder, so every producer spelling of one path agrees', () => {
    // Three spellings are in circulation and they all mean the same document: the path including
    // the file name (folderTreeParser, the Drive walk), and the directory with or without a
    // trailing separator. A bare directory name is why the file name, not the separator, has to be
    // the discriminator - `docs` and `README.md` are the same shape.
    const spellings = ['docs/README.md', 'docs/', 'docs'].map(relativePath =>
      sourceIdentityKeyFor({ relativePath, fileName: 'README.md' }, 'lake-1')
    );
    expect(spellings.map(identity => identity?.tier)).toEqual(['relativePath', 'relativePath', 'relativePath']);
    expect(new Set(spellings.map(identity => identity?.key)).size).toBe(1);
    // ...and a genuinely different folder still separates them - the whole point of the tier.
    expect(spellings[0]?.key).not.toBe(
      sourceIdentityKeyFor({ relativePath: 'src/README.md', fileName: 'README.md' }, 'lake-1')?.key
    );
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
