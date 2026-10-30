import { describe, expect, it } from 'vitest';
import { skillContentHash } from './contentHash';

const skill = {
  description: 'Review a PR',
  body: 'Check the diff.',
  argumentHint: '[pr]',
  allowedTools: ['web_search'],
  disableModelInvocation: false,
};

const toolSkill = {
  description: 'Formats text',
  body: 'Rewrite the text as bullets.',
  argumentHint: '[file]',
  allowedTools: ['web_search'],
  disableModelInvocation: true,
};

const files = [
  { path: 'scripts/run.py', content: 'print(1)' },
  { path: 'references/api.md', content: '# API' },
];

describe('skillContentHash', () => {
  it('keeps the hash a file-less skill had before supporting files existed', () => {
    const before = '41cb010e872aa98601dd373a460bab25c907b8218229dd3e655e137a6c0f17cd';
    expect(skillContentHash(skill)).toBe(before);
    expect(skillContentHash({ ...skill, files: [] })).toBe(before);
  });

  it('changes when only a supporting file changes, whatever the file order', () => {
    const withFiles = skillContentHash({ ...skill, files });
    expect(withFiles).not.toBe(skillContentHash(skill));
    expect(skillContentHash({ ...skill, files: [...files].reverse() })).toBe(withFiles);
    expect(skillContentHash({ ...skill, files: [{ ...files[0], content: 'print(2)' }, files[1]] })).not.toBe(withFiles);
    expect(skillContentHash({ ...skill, files: [{ ...files[0], path: 'scripts/go.py' }, files[1]] })).not.toBe(
      withFiles
    );
  });

  // Pinned from the formula before claudeCodeAllowedTools existed: stored importedFrom hashes must
  // keep matching, or every existing import would read as "locally modified".
  it('keeps the hash of a skill without Claude Code tools unchanged', () => {
    const pinned = '24b42d2104dbb50badf2aab5cbf56f1e0d5af08e4513ab2dacf23b09b560e0a7';
    expect(skillContentHash(toolSkill)).toBe(pinned);
    expect(skillContentHash({ ...toolSkill, claudeCodeAllowedTools: [] })).toBe(pinned);
  });

  it('changes the hash when Claude Code tools are declared', () => {
    expect(skillContentHash({ ...toolSkill, claudeCodeAllowedTools: ['Bash(git:*)'] })).not.toBe(
      skillContentHash(toolSkill)
    );
  });

  it('keeps a Claude Code tools hash when files are added later, and hashes the two together', () => {
    const tools = { ...toolSkill, claudeCodeAllowedTools: ['Bash(git:*)'] };
    expect(skillContentHash({ ...tools, files: [] })).toBe(skillContentHash(tools));
    const both = skillContentHash({ ...tools, files });
    expect(both).not.toBe(skillContentHash(tools));
    expect(both).not.toBe(skillContentHash({ ...toolSkill, files }));
  });
});
