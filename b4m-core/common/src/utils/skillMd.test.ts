import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import {
  b4mOnlyHints,
  buildClaudeCodeInstallCommand,
  parseSkillMd,
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
        body: 'Do it.',
      },
      dropped: ['allowed-tools', 'model', 'hooks'],
    });
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
  it('only matches the stamp inside the frontmatter fence', () => {
    expect(frontmatterHasSourceStamp('---\n# Bike4Mind-Source: https://x/skills/1\nname: a\n---\nbody')).toBe(true);
    expect(frontmatterHasSourceStamp('\uFEFF---\n# Bike4Mind-Source: https://x\n---\nbody')).toBe(true);
    expect(frontmatterHasSourceStamp('---\nname: a\n---\n# Bike4Mind-Source: https://x\n')).toBe(false);
    expect(frontmatterHasSourceStamp('# Bike4Mind-Source: https://x\n')).toBe(false);
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
