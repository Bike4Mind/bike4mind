import { describe, expect, it } from 'vitest';
import type { ApprovalPrompt } from '../tools/types';
import { everySessionRules, permissionSubject } from './subject';

const place = { roots: ['/work/project'], workingDirectory: '/work/project' };

function shellPrompt(
  commands: { text: string; pattern: string; coverable: boolean; opaque?: string }[],
  directories: string[] = []
): ApprovalPrompt {
  return { detail: '', key: 'k', always: { namespace: 'bash_execute', commands, directories } };
}

describe('permissionSubject', () => {
  it('resolves a file tool path against the working directory', () => {
    expect(permissionSubject({ name: 'file_read', input: { path: 'src/a.ts' } }, undefined, place).paths).toEqual([
      '/work/project/src/a.ts',
    ]);
    expect(permissionSubject({ name: 'glob_files', input: {} }, undefined, place).paths).toEqual(['/work/project']);
  });

  it('treats an unparsed script as one command only an exact rule can cover', () => {
    const subject = permissionSubject(
      { name: 'bash_execute', input: { command: 'if (' } },
      { detail: '', key: 'k' },
      place
    );
    expect(subject.shell?.commands).toEqual([{ text: 'if (', words: 'if (', coverable: false }]);
  });

  it('reads the host of a fetch and the server of an MCP tool', () => {
    expect(
      permissionSubject({ name: 'web_fetch', input: { url: 'https://Docs.Example.com/x' } }, undefined, place).host
    ).toBe('docs.example.com');
    const mcp = permissionSubject(
      { name: 'mcp__gh_search', input: {} },
      { detail: '', key: 'k', mcp: { server: 'gh', tool: 'search' } },
      place
    );
    expect(mcp.mcp).toEqual({ server: 'gh', tool: 'search' });
  });
});

describe('everySessionRules', () => {
  const rulesFor = (name: string, input: Record<string, unknown>, prompt: ApprovalPrompt) =>
    everySessionRules(permissionSubject({ name, input }, prompt, place), prompt);

  it('derives one Bash prefix rule per sub-command', () => {
    const prompt = shellPrompt([
      { text: 'git add .', pattern: 'git add *', coverable: true },
      { text: 'git commit -m x', pattern: 'git commit *', coverable: true },
    ]);
    expect(rulesFor('bash_execute', { command: 'git add . && git commit -m x' }, prompt)).toEqual([
      'Bash(git add:*)',
      'Bash(git commit:*)',
    ]);
  });

  it('derives nothing for an opaque or unnormalised command, or one reaching outside the shared folders', () => {
    expect(
      rulesFor(
        'bash_execute',
        { command: 'x' },
        shellPrompt([{ text: 'node -e x', pattern: 'node *', coverable: true, opaque: 'node -e' }])
      )
    ).toEqual([]);
    expect(
      rulesFor('bash_execute', { command: 'x' }, shellPrompt([{ text: 'A=1 ls', pattern: 'ls *', coverable: false }]))
    ).toEqual([]);
    expect(
      rulesFor(
        'bash_execute',
        { command: 'x' },
        shellPrompt([{ text: 'ls /etc', pattern: 'ls *', coverable: true }], ['/etc'])
      )
    ).toEqual([]);
  });

  it('derives nothing for an irreversible call or a card with a choice', () => {
    expect(rulesFor('session_delete', {}, { detail: '', key: 'k', irreversible: true })).toEqual([]);
    expect(
      rulesFor('web_fetch', { url: 'https://x.test/' }, { detail: '', key: 'k', choice: { options: [] } })
    ).toEqual([]);
  });

  it('derives an absolute Edit rule for a write and a domain rule for a fetch', () => {
    const diff = { path: '/work/project/a.ts', operation: 'update', lines: [] } as unknown as NonNullable<
      ApprovalPrompt['diff']
    >;
    expect(rulesFor('file_edit', { path: 'a.ts' }, { detail: '', key: 'k', diff })).toEqual([
      'Edit(//work/project/a.ts)',
    ]);
    expect(rulesFor('web_fetch', { url: 'https://x.test/a' }, { detail: '', key: 'k' })).toEqual([
      'WebFetch(domain:x.test)',
    ]);
  });
});
