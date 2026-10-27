import { describe, expect, it } from 'vitest';
import { skillContentHash } from './contentHash';

const skill = {
  description: 'Review a PR',
  body: 'Check the diff.',
  argumentHint: '[pr]',
  allowedTools: ['web_search'],
  disableModelInvocation: false,
};

describe('skillContentHash', () => {
  it('keeps the hash a file-less skill had before supporting files existed', () => {
    const before = '41cb010e872aa98601dd373a460bab25c907b8218229dd3e655e137a6c0f17cd';
    expect(skillContentHash(skill)).toBe(before);
    expect(skillContentHash({ ...skill, files: [] })).toBe(before);
  });

  it('changes when only a supporting file changes, whatever the file order', () => {
    const files = [
      { path: 'scripts/run.py', content: 'print(1)' },
      { path: 'references/api.md', content: '# API' },
    ];
    const withFiles = skillContentHash({ ...skill, files });
    expect(withFiles).not.toBe(skillContentHash(skill));
    expect(skillContentHash({ ...skill, files: [...files].reverse() })).toBe(withFiles);
    expect(skillContentHash({ ...skill, files: [{ ...files[0], content: 'print(2)' }, files[1]] })).not.toBe(withFiles);
    expect(skillContentHash({ ...skill, files: [{ ...files[0], path: 'scripts/go.py' }, files[1]] })).not.toBe(
      withFiles
    );
  });
});
