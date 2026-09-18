import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseFrontmatter } from './parseFrontmatter.js';

vi.mock('./Logger.js', () => ({ logger: { warn: vi.fn() } }));

describe('parseFrontmatter', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__frontmatterPwned;
  });

  it('parses YAML frontmatter into data + body', () => {
    const { data, content } = parseFrontmatter('---\nname: hi\ndescription: a skill\n---\n\nbody text');
    expect(data).toMatchObject({ name: 'hi', description: 'a skill' });
    expect(content.trim()).toBe('body text');
  });

  it('does not execute a `---js` frontmatter block; loads as empty', () => {
    const hostile = '---js\nglobalThis.__frontmatterPwned = true\n---\n\nbody';
    const { data } = parseFrontmatter(hostile);
    expect(data).toEqual({});
    expect((globalThis as Record<string, unknown>).__frontmatterPwned).toBeUndefined();
  });

  it('rejects any non-YAML language tag (e.g. toml) as empty without throwing', () => {
    const { data } = parseFrontmatter('---toml\nfoo = "bar"\n---\n\nbody');
    expect(data).toEqual({});
  });

  it('rejects a non-YAML tag even behind a leading BOM', () => {
    // A leading BOM would otherwise slip the `---js` fence past the language check.
    const hostile = String.fromCharCode(0xfeff) + '---js\nglobalThis.__frontmatterPwned = true\n---\n\nbody';
    const { data } = parseFrontmatter(hostile);
    expect(data).toEqual({});
    expect((globalThis as Record<string, unknown>).__frontmatterPwned).toBeUndefined();
  });

  it('degrades malformed YAML to empty frontmatter without throwing', () => {
    const { data } = parseFrontmatter('---\n:\n  - : :\nbad indent\n---\n\nbody');
    expect(data).toEqual({});
  });

  it('accepts an explicit yaml/yml language tag', () => {
    const { data } = parseFrontmatter('---yaml\ndescription: ok\n---\n\nbody');
    expect(data).toMatchObject({ description: 'ok' });
  });

  it('returns empty data and unchanged content when there is no frontmatter', () => {
    const { data, content } = parseFrontmatter('# Title\n\njust markdown');
    expect(data).toEqual({});
    expect(content).toContain('just markdown');
  });
});
