import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import YAML from 'yaml';
import {
  b4mOnlyHints,
  buildClaudeCodeInstallCommand,
  parseSkillMd,
  referencedRelativePaths,
  toSkillMd,
  SKILL_MD_THIRD_PARTY_NOTE,
  type SkillMdSkill,
} from './skillMd';
import { frontmatterHasSourceStamp, splitSkillMdFrontmatter } from './skillMdSource';

const mapped = (s: SkillMdSkill) => ({
  name: s.name,
  description: s.description,
  body: s.body,
  ...(s.argumentHint && { argumentHint: s.argumentHint }),
  ...(s.disableModelInvocation && { disableModelInvocation: true }),
});

describe('toSkillMd / parseSkillMd round trip', () => {
  const cases: SkillMdSkill[] = [
    { name: 'plain', description: 'Summarize a file', body: 'Summarize $ARGUMENTS.' },
    {
      name: 'special-chars',
      description: 'Key: value, "quoted" and \'single\' # not a comment',
      argumentHint: '[file] [--flag: x]',
      body: '# Heading\n\nRun `echo $HOME` then\nEOF\n---\nmore',
      disableModelInvocation: true,
    },
    { name: 'multiline', description: 'line one\nline two', body: 'body', disableModelInvocation: false },
    { name: 'trailing-newline', description: 'd', body: 'ends with newline\n' },
  ];

  it.each(cases)('$name', skill => {
    const parsed = parseSkillMd(toSkillMd(skill, { sourceUrl: 'https://app.example/skills/1', version: 3 }));
    expect(parsed.ok && parsed.fields).toEqual(mapped(skill));
    expect(parsed.ok && parsed.dropped).toEqual([]);
  });

  it('emits valid YAML frontmatter with the stamp comments first and no allowedTools', () => {
    const md = toSkillMd({ ...cases[1], allowedTools: ['web_search'] } as SkillMdSkill, {
      sourceUrl: 'https://app.example/skills/market/abc',
      version: 2,
      exportedAt: new Date('2026-10-20T12:00:00Z'),
      thirdParty: true,
    });
    const lines = md.split('\n');
    expect(lines.slice(0, 5)).toEqual([
      '---',
      '# Bike4Mind-Source: https://app.example/skills/market/abc',
      '# Version: 2',
      '# Exported: 2026-10-20',
      `# ${SKILL_MD_THIRD_PARTY_NOTE}`,
    ]);
    const split = splitSkillMdFrontmatter(md);
    expect(YAML.parse(split!.frontmatter)).toEqual({
      name: 'special-chars',
      description: cases[1].description,
      'argument-hint': cases[1].argumentHint,
      'disable-model-invocation': true,
    });
    expect(md).not.toContain('allowed');
  });

  it('omits optional stamp lines and is deterministic without exportedAt', () => {
    const md = toSkillMd(cases[0]);
    expect(md).toBe('---\nname: plain\ndescription: Summarize a file\n---\n\nSummarize $ARGUMENTS.\n');
    expect(toSkillMd(cases[0])).toBe(md);
  });
});

describe('parseSkillMd', () => {
  it('maps Claude Code keys and reports unsupported ones as dropped', () => {
    const result = parseSkillMd(
      '---\nname: review\ndescription: Review a PR\nargument-hint: "[pr]"\ndisable-model-invocation: true\nallowed-tools: Bash, Read\nmodel: opus\nhooks:\n  a: b\n---\n\nDo it.\n'
    );
    expect(result).toEqual({
      ok: true,
      fields: {
        name: 'review',
        description: 'Review a PR',
        argumentHint: '[pr]',
        disableModelInvocation: true,
        claudeCodeAllowedTools: ['Bash', 'Read'],
        body: 'Do it.',
      },
      dropped: ['model', 'hooks'],
    });
  });

  it.each([
    ['a comma string', 'allowed-tools: Bash(git:*), Read', ['Bash(git:*)', 'Read']],
    [
      'a space string with a space inside parens',
      'allowed-tools: Bash(git add:*) Read Grep',
      ['Bash(git add:*)', 'Read', 'Grep'],
    ],
    ['a YAML list', 'allowed-tools:\n  - Bash(gh pr view:*)\n  - Read', ['Bash(gh pr view:*)', 'Read']],
    ['a YAML list entry packing several tools', 'allowed-tools:\n  - "Read(x), Bash"', ['Read(x)', 'Bash']],
    ['an unclosed paren', 'allowed-tools: Read, Bash(git add', ['Read', 'Bash(git add']],
  ])('keeps allowed-tools given as %s', (_label, line, expected) => {
    const result = parseSkillMd(`---\nname: x\n${line}\n---\nDo it.`);
    expect(result).toMatchObject({ ok: true, fields: { claudeCodeAllowedTools: expected }, dropped: [] });
  });

  it('does not report an empty allowed-tools list as dropped', () => {
    expect(parseSkillMd('---\nname: x\nallowed-tools: []\n---\nDo it.')).toMatchObject({ ok: true, dropped: [] });
  });

  it('reports an allowed-tools value it cannot read as dropped', () => {
    const result = parseSkillMd('---\nname: x\nallowed-tools:\n  bash: yes\n---\nDo it.');
    expect(result).toMatchObject({ ok: true, dropped: ['allowed-tools'] });
    expect(result.ok && result.fields.claudeCodeAllowedTools).toBeUndefined();
  });

  it('round-trips allowed-tools through toSkillMd, never writing B4M allowedTools', () => {
    const md = toSkillMd({
      name: 'commit',
      description: 'Commit',
      body: 'Do it.',
      claudeCodeAllowedTools: ['Bash(git add:*)', 'Read'],
    });
    expect(md).toContain('allowed-tools: Bash(git add:*), Read');
    const parsed = parseSkillMd(md);
    expect(parsed.ok && parsed.fields.claudeCodeAllowedTools).toEqual(['Bash(git add:*)', 'Read']);
    expect(toSkillMd({ name: 'x', description: 'y', body: 'z', claudeCodeAllowedTools: [] })).not.toContain(
      'allowed-tools'
    );
  });

  it.each([
    ['autoinvoke: false\n', true],
    ['autoinvoke: "false"\n', true],
    ['autoinvoke: true\n', false],
    ['autoinvoke: false\ndisable-model-invocation: false\n', true],
    ['disable-model-invocation: true\nautoinvoke: true\n', true],
  ])('maps autoinvoke %j to disableModelInvocation %s', (frontmatter, expected) => {
    const result = parseSkillMd(`---\nname: x\n${frontmatter}---\n\nbody\n`);
    expect(result).toMatchObject({ ok: true, fields: { disableModelInvocation: expected }, dropped: [] });
  });

  it.each([
    ['[pr]', '[pr]'],
    ['[pr-number] [priority] [assignee]', '[pr-number] [priority] [assignee]'],
    ['[a, b]  ', '[a, b]'],
    ['<optional: title>', '<optional: title>'],
    ['[pr #123]', '[pr #123]'],
    ['<file #line>', '<file #line>'],
    ['[pr] # note', '[pr]'],
    ['[pr #123] [priority] # note', '[pr #123] [priority]'],
    ['<file #line> # note', '<file #line>'],
    ['a: b # c', 'a: b'],
    ['a: b#c', 'a: b#c'],
    ['plain # note', 'plain'],
    ['"a: b # c"', 'a: b # c'],
    ["'a: b # c'", 'a: b # c'],
  ])('keeps an unquoted Claude Code argument-hint %j verbatim', (raw, hint) => {
    const result = parseSkillMd(`---\nname: review\nargument-hint: ${raw}\n---\nDo it.\n`);
    expect(result).toEqual({ ok: true, fields: { name: 'review', argumentHint: hint, body: 'Do it.' }, dropped: [] });
  });

  it('normalizes CRLF line endings so the body survives the install command', () => {
    const result = parseSkillMd('---\r\nname: a\r\ndescription: d\r\nargument-hint: [pr]\r\n---\r\nline1\r\nline2\r\n');
    expect(result).toEqual({
      ok: true,
      fields: { name: 'a', description: 'd', argumentHint: '[pr]', body: 'line1\nline2' },
      dropped: [],
    });
    if (!result.ok) throw new Error(result.error);

    const exported = toSkillMd({ name: 'a', description: 'd', body: result.fields.body ?? '' });
    expect(() => buildClaudeCodeInstallCommand('a', exported)).not.toThrow();
  });

  it('treats a file without frontmatter as all body', () => {
    expect(parseSkillMd('Just instructions\n')).toEqual({
      ok: true,
      fields: { body: 'Just instructions' },
      dropped: [],
    });
  });

  it('coerces scalar values and ignores wrong types', () => {
    const result = parseSkillMd('---\nname: 42\ndescription: [a, b]\n---\nx');
    expect(result.ok && result.fields).toEqual({ name: '42', body: 'x' });
  });

  it.each([
    ['a non-YAML fence', '---js\n{ name: "x" }\n---\nbody'],
    ['a BOM-prefixed non-YAML fence', '\uFEFF---javascript\nname: x\n---\nbody'],
    ['invalid YAML', '---\nname: [unclosed\n---\nbody'],
    ['a non-mapping frontmatter', '---\n- a\n- b\n---\nbody'],
    ['an unclosed fence', '---\nname: x\nbody'],
  ])('rejects %s without throwing', (_label, text) => {
    const result = parseSkillMd(text);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toBeTruthy();
  });

  it('returns source for stamped exports and flags third-party ones', () => {
    const skill = { name: 'x', description: 'd', body: 'b' };
    const own = parseSkillMd(toSkillMd(skill, { sourceUrl: 'https://app.example/skills/1' }));
    expect(own.ok && own.source).toEqual({ url: 'https://app.example/skills/1', thirdParty: false });
    const market = parseSkillMd(
      toSkillMd(skill, { sourceUrl: 'https://app.example/skills/market/2', thirdParty: true })
    );
    expect(market.ok && market.source).toEqual({ url: 'https://app.example/skills/market/2', thirdParty: true });
    const plain = parseSkillMd(toSkillMd(skill));
    expect(plain.ok && plain.source).toBeUndefined();
  });
});

describe('frontmatterHasSourceStamp', () => {
  it.each([
    'description: "hello\n# Bike4Mind-Source: https://x/skills/1\nworld"',
    "description: 'hello\n# Bike4Mind-Source: https://x/skills/1\nworld'",
  ])('does not inspect marker text after YAML values begin: %s', frontmatter => {
    expect(frontmatterHasSourceStamp(`---\n${frontmatter}\n---\nbody`)).toBe(false);
  });

  it('recognizes a stamp after leading blank lines and other comments', () => {
    expect(
      frontmatterHasSourceStamp(
        '---\n\n# Exported skill\n  # Another comment\n# Bike4Mind-Source: https://x\nname: local\n---\nbody'
      )
    ).toBe(true);
  });

  it.each([
    ['a description block scalar', 'description: |\n  Example export:\n  # Bike4Mind-Source: https://x/skills/1'],
    ['an empty marker', '# Bike4Mind-Source:'],
    ['a whitespace-only marker', '# Bike4Mind-Source:   '],
  ])('does not mistake %s for an export stamp', (_label, frontmatter) => {
    const text = `---\n${frontmatter}\nname: local\n---\nbody`;
    expect(frontmatterHasSourceStamp(text)).toBe(false);
    const result = parseSkillMd(text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.source).toBeUndefined();
  });

  it('only matches the stamp inside the frontmatter fence', () => {
    expect(frontmatterHasSourceStamp('---\n# Bike4Mind-Source: https://x/skills/1\nname: a\n---\nbody')).toBe(true);
    expect(frontmatterHasSourceStamp('\uFEFF---\n# Bike4Mind-Source: https://x\n---\nbody')).toBe(true);
    expect(frontmatterHasSourceStamp('---\r\n# Bike4Mind-Source: https://x\r\nname: a\r\n---\r\nbody')).toBe(true);
    expect(frontmatterHasSourceStamp('---\nname: a\n---\n# Bike4Mind-Source: https://x\n')).toBe(false);
    expect(frontmatterHasSourceStamp('# Bike4Mind-Source: https://x\n')).toBe(false);
  });

  it('recognizes a stamp in the leading comment header', () => {
    const text = '---\n\n# Exported skill\n  # Bike4Mind-Source: https://x/skills/1\nname: a\n---\nbody';
    expect(frontmatterHasSourceStamp(text)).toBe(true);
    const result = parseSkillMd(text);
    expect(result.ok && result.source).toEqual({ url: 'https://x/skills/1', thirdParty: false });
  });

  it('recognizes header stamps with a BOM, CRLF, and tab indentation', () => {
    expect(
      frontmatterHasSourceStamp(
        '\uFEFF---\r\n\r\n# Header\r\n\t#\tBike4Mind-Source:\thttps://x\r\nname: a\r\n---\r\nbody'
      )
    ).toBe(true);
  });

  it('rejects an empty source stamp and a comment header without one', () => {
    expect(frontmatterHasSourceStamp('---\n# Bike4Mind-Source:\nname: a\n---\nbody')).toBe(false);
    expect(frontmatterHasSourceStamp('---\n# Header\n\nname: a\n---\nbody')).toBe(false);
  });

  it('only recognizes the header convention, not a source comment after YAML data', () => {
    expect(frontmatterHasSourceStamp('---\nname: a\n# Bike4Mind-Source: https://x\n---\nbody')).toBe(false);
  });

  it.each([
    'description: |\n  # Bike4Mind-Source: https://x/skills/1',
    'description: >\n  # Bike4Mind-Source: https://x/skills/1',
    'description: "a description\n  # Bike4Mind-Source: https://x/skills/1\n  continued"',
    "description: 'a description\n  # Bike4Mind-Source: https://x/skills/1\n  continued'",
  ])('does not mistake scalar content for a source stamp: %s', frontmatter => {
    const text = `---\n${frontmatter}\n---\nbody`;
    expect(frontmatterHasSourceStamp(text)).toBe(false);
    const result = parseSkillMd(text);
    expect(result.ok).toBe(true);
    expect(result.ok && result.source).toBeUndefined();
  });
});

describe('referencedRelativePaths', () => {
  it('finds relative link targets and bare script/doc paths, ignoring URLs, anchors and absolute paths', () => {
    const body = [
      'Run `scripts/lint.sh` then ./tools/fix.py.',
      'See [the guide](reference.md#setup) and ![chart](img/chart.png).',
      'Not these: [site](https://example.test/a/install.sh), [top](#usage), [root](/etc/x.md), mailto:[a](mailto:a@b.test).',
      'Nor package.json or Node.js in prose; scripts/lint.sh again.',
    ].join('\n');
    expect(referencedRelativePaths(body)).toEqual([
      'reference.md',
      'img/chart.png',
      'scripts/lint.sh',
      './tools/fix.py',
    ]);
  });

  it('returns nothing for a self-contained body', () => {
    expect(referencedRelativePaths('Summarize the diff in three bullets.')).toEqual([]);
  });
});

describe('b4mOnlyHints', () => {
  it('reports B4M tools and @agent mentions', () => {
    expect(
      b4mOnlyHints({
        body: '@github_manager open a PR.\nThen ask @jira_bot and @github_manager.',
        allowedTools: ['web_search'],
      })
    ).toEqual({ tools: ['web_search'], agents: ['github_manager', 'jira_bot'] });
  });

  it('reports nothing for a plain skill or one that only mentions an email address', () => {
    expect(b4mOnlyHints({ body: 'Summarize this.' })).toEqual({ tools: [], agents: [] });
    expect(b4mOnlyHints({ body: 'Email someone@example.com or a@b.co', allowedTools: [] })).toEqual({
      tools: [],
      agents: [],
    });
  });
});

describe('buildClaudeCodeInstallCommand', () => {
  const content = toSkillMd({
    name: 'tricky',
    description: 'Uses: "quotes" # and more',
    body: 'Echo $HOME and `whoami` and $(id)\nEOF\nB4M_SKILL_\n\'single\' "double" \\ backslash',
  });

  it('builds a quoted heredoc with a nonce delimiter', () => {
    const cmd = buildClaudeCodeInstallCommand('tricky', content);
    const lines = cmd.split('\n');
    const delimiter = lines.at(-1)!;
    expect(delimiter).toMatch(/^B4M_SKILL_[0-9a-f]{12}$/);
    expect(lines[0]).toBe(
      `mkdir -p ~/.claude/skills/tricky && cat > ~/.claude/skills/tricky/SKILL.md <<'${delimiter}'`
    );
    expect(lines.slice(1, -1).join('\n') + '\n').toBe(content);
  });

  it('rejects a name that is not path-safe', () => {
    expect(() => buildClaudeCodeInstallCommand('../evil', content)).toThrow();
    expect(() => buildClaudeCodeInstallCommand('a b', content)).toThrow();
  });

  it('retries when a generated heredoc delimiter occurs in the content', () => {
    const randomValues = vi
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockReturnValueOnce(new Uint8Array(6))
      .mockReturnValueOnce(new Uint8Array(6).fill(1));
    try {
      const command = buildClaudeCodeInstallCommand('tricky', 'B4M_SKILL_000000000000\nbody\n');
      expect(randomValues).toHaveBeenCalledTimes(2);
      expect(command.split('\n').at(-1)).toBe('B4M_SKILL_010101010101');
      expect(command).toContain('\nB4M_SKILL_000000000000\nbody\n');
    } finally {
      randomValues.mockRestore();
    }
  });

  it.each([['\t'], ['\u0003'], ['\r'], ['\u001b'], ['\u007f'], ['\u009b']])(
    'rejects content with the control byte %j',
    byte => {
      expect(() => buildClaudeCodeInstallCommand('tricky', `${content}${byte}`)).toThrow();
    }
  );

  it('accepts newlines', () => {
    expect(() => buildClaudeCodeInstallCommand('tricky', 'a b\nc')).not.toThrow();
  });

  let hasBash = true;
  try {
    execFileSync('bash', ['-c', 'true']);
  } catch {
    hasBash = false;
  }

  it.skipIf(!hasBash)('writes the content byte-for-byte when run in bash', () => {
    const home = mkdtempSync(join(tmpdir(), 'skillmd-'));
    try {
      execFileSync('bash', ['-c', buildClaudeCodeInstallCommand('tricky', content)], {
        env: { ...process.env, HOME: home },
      });
      expect(readFileSync(join(home, '.claude/skills/tricky/SKILL.md'), 'utf-8')).toBe(content);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
