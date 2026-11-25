import { describe, expect, it } from 'vitest';
import { FrontmatterLanguageError, parseFrontmatter } from './frontmatter';

describe('parseFrontmatter', () => {
  it('splits YAML frontmatter from the body', () => {
    expect(parseFrontmatter('---\ntitle: Hi\ntags: [a, b]\n---\n\n# Body\n')).toEqual({
      data: { title: 'Hi', tags: ['a', 'b'] },
      content: '\n# Body\n',
    });
  });

  it('returns the whole file as content when there is no frontmatter', () => {
    expect(parseFrontmatter('# Title\n\n---\n\nmore')).toEqual({ data: {}, content: '# Title\n\n---\n\nmore' });
    expect(parseFrontmatter('')).toEqual({ data: {}, content: '' });
    expect(parseFrontmatter('----\na: 1\n----\n')).toEqual({ data: {}, content: '----\na: 1\n----\n' });
  });

  it('returns empty data for an empty, comment-only or null fence', () => {
    expect(parseFrontmatter('---\n---\nbody')).toEqual({ data: {}, content: 'body' });
    expect(parseFrontmatter('---')).toEqual({ data: {}, content: '' });
    expect(parseFrontmatter('---\n# Bike4Mind-Source: https://example.com\n---\nbody')).toEqual({
      data: {},
      content: 'body',
    });
    expect(parseFrontmatter('---\n~\n---\nbody')).toEqual({ data: {}, content: 'body' });
  });

  it('handles CRLF and a BOM', () => {
    expect(parseFrontmatter('\u{FEFF}---\r\ntitle: x\r\nsidebar_position: 2\r\n---\r\nbody\r\n')).toEqual({
      data: { title: 'x', sidebar_position: 2 },
      content: 'body\r\n',
    });
  });

  it('closes at the first `---` line', () => {
    expect(parseFrontmatter('---\na: 1\n---\nx\n---\ny')).toEqual({ data: { a: 1 }, content: 'x\n---\ny' });
    expect(parseFrontmatter('---\na: 1\n---   \nbody')).toEqual({ data: { a: 1 }, content: '   \nbody' });
  });

  it('reads an unclosed fence to the end of the file', () => {
    expect(parseFrontmatter('---\na: 1\n')).toEqual({ data: { a: 1 }, content: '' });
  });

  it('keeps YAML 1.1 timestamps and merge keys, with YAML 1.2 booleans', () => {
    const { data } = parseFrontmatter(
      '---\nd: 2024-01-15\nt: 2024-01-15 10:30:00\nyes: yes\nok: True\nbase: &b\n  x: 1\nmerged:\n  <<: *b\n---\n'
    );
    expect(data).toEqual({
      d: new Date('2024-01-15T00:00:00.000Z'),
      t: new Date('2024-01-15T10:30:00.000Z'),
      yes: 'yes',
      ok: true,
      base: { x: 1 },
      merged: { x: 1 },
    });
  });

  it.each([
    ['010', 8],
    ['-010', -8],
    ['0_10', 8],
    ['08', '08'],
    ['09', '09'],
    ['0o10', '0o10'],
    ['0b10', 2],
    ['0b_10', 2],
    ['0b1_', '0b1_'],
    ['0xF_', '0xF_'],
    ['1_000', 1000],
    ['1_', '1_'],
    ['1:20', 80],
    ['1:20.5', 80.5],
    ['1._', '1._'],
    ['.', '.'],
    ['e4', 'e4'],
    ['+.2', '+.2'],
    ['.2', 0.2],
    ['.inf', Infinity],
    ['.nan', NaN],
    ['yes', 'yes'],
    ['NO', 'NO'],
    ['True', true],
    ['FALSE', false],
    ['!!int "010"', 8],
    ['!!float "1:20.5"', 80.5],
    ['!!bool "True"', true],
  ])('preserves the existing safe-schema scalar %s', (source, value) => {
    expect(parseFrontmatter(`---\nvalue: ${source}\n---\n`).data.value).toEqual(value);
  });

  it.each([
    '!!int nope',
    '!!int 08',
    '!!float nope',
    '!!bool yes',
    '!!unknown value',
    '!!int "1\\n"',
    '!!int "010\\n"',
  ])('rejects the unresolved explicit scalar %s', source =>
    expect(() => parseFrontmatter(`---\nvalue: ${source}\n---\n`)).toThrow()
  );

  it('preserves an existing agent iteration limit written with a leading zero', () => {
    expect(parseFrontmatter('---\nmax-iterations:\n  quick: 010\n---\n').data).toEqual({
      'max-iterations': { quick: 8 },
    });
  });

  it('accepts a yaml or yml language tag in any case', () => {
    expect(parseFrontmatter('---yaml\na: 1\n---\n').data).toEqual({ a: 1 });
    expect(parseFrontmatter('---yml \na: 1\n---\n').data).toEqual({ a: 1 });
    expect(parseFrontmatter('---YAML\na: 1\n---\n').data).toEqual({ a: 1 });
  });

  it('rejects any other language tag without reading the block', () => {
    const run = () => parseFrontmatter('---js\nglobalThis.__frontmatterPwned = true\n---\nbody');
    expect(run).toThrow(FrontmatterLanguageError);
    expect(run).toThrow('Unsupported front matter language "js"');
    expect((globalThis as Record<string, unknown>).__frontmatterPwned).toBeUndefined();
    expect(() => parseFrontmatter('\u{FEFF}---toml\na = 1\n---\n')).toThrow(FrontmatterLanguageError);
  });

  it('throws on invalid YAML, duplicate keys and frontmatter that is not a mapping', () => {
    expect(() => parseFrontmatter('---\n:\n  - : :\nbad indent\n---\nbody')).toThrow();
    expect(() => parseFrontmatter('---\na: 1\na: 2\n---\n')).toThrow();
    expect(() => parseFrontmatter('---\nhello\n---\nbody')).toThrow('must be a set of key: value pairs');
    expect(() => parseFrontmatter('---\n- a\n---\nbody')).toThrow('must be a set of key: value pairs');
    expect(() => parseFrontmatter('---\n2024-01-15\n---\nbody')).toThrow('must be a set of key: value pairs');
  });
});
