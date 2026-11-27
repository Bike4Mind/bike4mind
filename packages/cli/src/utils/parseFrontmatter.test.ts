import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentFrontmatterSchema } from '../agents/types.js';
import { parseFrontmatter } from './parseFrontmatter.js';
import { logger } from './Logger.js';

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

  it('strips a leading BOM so the non-YAML tag is caught at the fence check', () => {
    // Isolate this test's warn calls: the non-BOM `---js` case above also warns
    // with the same message, so a stale call would mask a missing BOM strip.
    vi.mocked(logger.warn).mockClear();

    const hostile = String.fromCharCode(0xfeff) + '---js\nglobalThis.__frontmatterPwned = true\n---\n\nbody';
    const { data } = parseFrontmatter(hostile);
    expect(data).toEqual({});
    expect((globalThis as Record<string, unknown>).__frontmatterPwned).toBeUndefined();

    // Pins the BOM strip: without it the fence regex misses `---js` (BOM is the
    // first char) and the engine-disabled path fires a different warning instead.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Ignoring non-YAML frontmatter language "js"'));
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

  it('returns empty data for an empty file, an empty fence and a comment-only fence', () => {
    expect(parseFrontmatter('')).toEqual({ data: {}, content: '' });
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, content: 'body' });
    expect(parseFrontmatter('---\n\n---\n\nbody')).toEqual({ data: {}, content: '\nbody' });
    expect(parseFrontmatter('---\n# only a comment\n---\nbody')).toEqual({ data: {}, content: 'body' });
  });

  it('reads CRLF files without carrying a CR into the values or the body', () => {
    expect(parseFrontmatter('---\r\nname: x\r\ndescription: y\r\n---\r\nbody\r\nmore')).toEqual({
      data: { name: 'x', description: 'y' },
      content: 'body\r\nmore',
    });
  });

  it('parses frontmatter behind a BOM', () => {
    expect(parseFrontmatter('\u{FEFF}---\nname: x\n---\nbody')).toEqual({ data: { name: 'x' }, content: 'body' });
  });

  it('closes at the first `---` line and keeps later ones in the body', () => {
    expect(parseFrontmatter('---\nname: x\n---\nintro\n---\nmore\n---\n')).toEqual({
      data: { name: 'x' },
      content: 'intro\n---\nmore\n---\n',
    });
    expect(parseFrontmatter('---\nname: "a --- b"\n---\nbody').data).toEqual({ name: 'a --- b' });
  });

  it('does not treat a `----` rule as a fence', () => {
    expect(parseFrontmatter('----\nname: x\n----\nbody')).toEqual({ data: {}, content: '----\nname: x\n----\nbody' });
  });

  it('reads the rest of the file as frontmatter when the fence is never closed', () => {
    expect(parseFrontmatter('---\nname: x\n')).toEqual({ data: { name: 'x' }, content: '' });
  });

  it('parses unquoted dates as UTC Dates and quoted ones as strings', () => {
    const { data } = parseFrontmatter(
      '---\ndate: 2024-01-15\nupdated: 2024-01-15 10:30:00\nzoned: 2001-12-14t21:59:43.10-05:00\nquoted: "2024-01-15"\n---\n'
    );
    expect(data).toEqual({
      date: new Date('2024-01-15T00:00:00.000Z'),
      updated: new Date('2024-01-15T10:30:00.000Z'),
      zoned: new Date('2001-12-15T02:59:43.100Z'),
      quoted: '2024-01-15',
    });
  });

  it('parses only true/false spellings as booleans; yes/no/on/off stay strings', () => {
    const { data } = parseFrontmatter('---\na: true\nb: False\nc: TRUE\nd: yes\ne: no\nf: on\ng: off\nh: y\n---\n');
    expect(data).toEqual({ a: true, b: false, c: true, d: 'yes', e: 'no', f: 'on', g: 'off', h: 'y' });
  });

  it('parses nulls, numbers, lists, block scalars and merge keys', () => {
    const { data } = parseFrontmatter(
      [
        '---',
        'a: ~',
        'b:',
        'n: 42',
        'f: 3.10',
        'hex: 0x1F',
        'exp: 1e3',
        'tags: [a, b]',
        'allowed-tools:',
        '  - read',
        'folded: >',
        '  one',
        '  two',
        'base: &b',
        '  x: 1',
        'derived:',
        '  <<: *b',
        '  y: 2',
        '---',
        '',
      ].join('\n')
    );
    expect(data).toEqual({
      a: null,
      b: null,
      n: 42,
      f: 3.1,
      hex: 31,
      exp: 1000,
      tags: ['a', 'b'],
      'allowed-tools': ['read'],
      folded: 'one two\n',
      base: { x: 1 },
      derived: { x: 1, y: 2 },
    });
  });

  it('parses a Claude Code style SKILL.md', () => {
    const skill = [
      '---',
      'name: pdf-tools',
      'description: "Extract text from PDFs. Use when: the user attaches a PDF"',
      'argument-hint: "[file] [pages]"',
      'allowed-tools: Read, Bash(pdftotext:*)',
      'disable-model-invocation: true',
      'user-invocable: false',
      '# Bike4Mind-Source: https://example.com/skills/pdf-tools',
      '---',
      '',
      '# PDF tools',
      '',
      'Run `pdftotext` on $ARGUMENTS.',
      '',
    ].join('\n');
    expect(parseFrontmatter(skill)).toEqual({
      data: {
        name: 'pdf-tools',
        description: 'Extract text from PDFs. Use when: the user attaches a PDF',
        'argument-hint': '[file] [pages]',
        'allowed-tools': 'Read, Bash(pdftotext:*)',
        'disable-model-invocation': true,
        'user-invocable': false,
      },
      content: '\n# PDF tools\n\nRun `pdftotext` on $ARGUMENTS.\n',
    });
  });

  it('parses every built-in agent definition', async () => {
    const dir = fileURLToPath(new URL('../agents/defaults/', import.meta.url));
    const files = (await readdir(dir)).filter(file => file.endsWith('.md'));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const { data, content } = parseFrontmatter(await readFile(join(dir, file), 'utf-8'));
      expect(AgentFrontmatterSchema.safeParse(data).success, file).toBe(true);
      expect(content.trim().length, file).toBeGreaterThan(0);
      expect(content.startsWith('---'), file).toBe(false);
    }

    const explore = parseFrontmatter(await readFile(join(dir, 'explore.md'), 'utf-8'));
    expect(explore.data).toEqual({
      description: 'Fast codebase exploration and search',
      model: 'claude-haiku-4-5-20251001',
      'allowed-tools': ['file_read', 'grep_search', 'glob_files', 'bash_execute', 'current_datetime', 'math_evaluate'],
      'denied-tools': [
        'create_file',
        'edit_file',
        'delete_file',
        'web_search',
        'weather_info',
        'blog_publish',
        'blog_edit',
        'blog_draft',
      ],
      'max-iterations': { quick: 4, medium: 10, very_thorough: 20 },
      'default-thoroughness': 'medium',
      'shared-context': ['read', 'write'],
    });
    expect(explore.content.startsWith('\nYou are a code exploration specialist.')).toBe(true);
  });
});
