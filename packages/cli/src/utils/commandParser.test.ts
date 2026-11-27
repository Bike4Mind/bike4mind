/**
 * parseCommandFile must route frontmatter through parseFrontmatter, which reads only YAML and
 * never evaluates a `---js` fence. A command file lives in an untrusted clone, so the case
 * guarded in parseFrontmatter.test.ts is pinned at this call site too.
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

describe('parseCommandFile model-invocation opt-out', () => {
  const parse = (frontmatter: string) =>
    parseCommandFile(`---\ndescription: d\n${frontmatter}\n---\n\nbody`, '/proj/x.md', 'x', 'global');

  it("honours Claude Code's disable-model-invocation", () => {
    expect(parse('disable-model-invocation: true').disableModelInvocation).toBe(true);
  });

  it("honours opencode's autoinvoke: false", () => {
    expect(parse('autoinvoke: false').disableModelInvocation).toBe(true);
    expect(parse('autoinvoke: true').disableModelInvocation).toBe(false);
  });

  it('ignores a malformed autoinvoke rather than discarding the rest of the frontmatter', () => {
    const command = parse('autoinvoke: "off"');
    expect(command.description).toBe('d');
    expect(command.disableModelInvocation).toBe(false);
  });

  it('leaves a skill model-invocable by default', () => {
    expect(parse('').disableModelInvocation).toBe(false);
  });
});
