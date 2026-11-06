import { describe, it, expect } from 'vitest';
import { Skill } from './SkillModel';
import { SkillListingVersion } from './SkillListingVersionModel';

// checkSkillFiles (@bike4mind/common utils/skillFiles.ts) allows an empty file, e.g. scripts/__init__.py.
describe('supporting files schema', () => {
  const files = [{ path: 'scripts/__init__.py', content: '' }];

  it('accepts an empty file on a skill', () => {
    const doc = new Skill({ name: 's', description: 'd', body: 'b', userId: 'u', files });
    expect(doc.validateSync()?.errors['files.0.content']).toBeUndefined();
  });

  it('accepts an empty file on a version snapshot', () => {
    const doc = new SkillListingVersion({ snapshot: { name: 's', description: 'd', body: 'b', files } });
    expect(doc.validateSync()?.errors['snapshot.files.0.content']).toBeUndefined();
  });
});
