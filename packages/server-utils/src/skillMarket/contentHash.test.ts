import { describe, it, expect } from 'vitest';
import { skillContentHash } from './contentHash';

const skill = {
  description: 'Formats text',
  body: 'Rewrite the text as bullets.',
  argumentHint: '[file]',
  allowedTools: ['web_search'],
  disableModelInvocation: true,
};

describe('skillContentHash', () => {
  // Pinned from the formula before claudeCodeAllowedTools existed: stored importedFrom hashes must
  // keep matching, or every existing import would read as "locally modified".
  it('keeps the hash of a skill without Claude Code tools unchanged', () => {
    const pinned = '24b42d2104dbb50badf2aab5cbf56f1e0d5af08e4513ab2dacf23b09b560e0a7';
    expect(skillContentHash(skill)).toBe(pinned);
    expect(skillContentHash({ ...skill, claudeCodeAllowedTools: [] })).toBe(pinned);
  });

  it('changes the hash when Claude Code tools are declared', () => {
    expect(skillContentHash({ ...skill, claudeCodeAllowedTools: ['Bash(git:*)'] })).not.toBe(skillContentHash(skill));
  });
});
