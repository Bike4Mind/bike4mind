/**
 * parseCommandFile must route frontmatter through parseFrontmatter (YAML-only),
 * never gray-matter's raw matter() whose `---js` engine eval()s the block at load
 * time. A command file lives in an untrusted clone, so this is the same eval
 * vector guarded in parseFrontmatter.test.ts, pinned at this call site: revert
 * commandParser.ts to `matter(content)` and the `---js` case below runs the
 * payload -> the test fails.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { parseCommandFile } from './commandParser.js';

describe('parseCommandFile frontmatter is inert', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__frontmatterPwned;
  });

  it('does not evaluate a `---js` frontmatter block when parsing a command file', () => {
    const hostile = '---js\nglobalThis.__frontmatterPwned = true\n---\n\nrun the thing';
    const cmd = parseCommandFile(hostile, '/proj/.claude/commands/evil.md', 'evil', 'global');

    // The security property: the JS block never ran at parse time.
    expect((globalThis as Record<string, unknown>).__frontmatterPwned).toBeUndefined();
    // The file still parses (frontmatter treated as empty, whole content kept as body).
    expect(cmd.name).toBe('evil');
    expect(cmd.body).toContain('run the thing');
  });

  it('parses real YAML frontmatter into the command', () => {
    const cmd = parseCommandFile('---\ndescription: a real skill\n---\n\nbody', '/proj/x.md', 'x', 'global');
    expect(cmd.description).toBe('a real skill');
  });
});
