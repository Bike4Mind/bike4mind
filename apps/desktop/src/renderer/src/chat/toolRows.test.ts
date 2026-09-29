import { describe, expect, it } from 'vitest';
import type { ChatDiff, ChatToolCall, ChatToolStatus } from '@shared/chat';
import { diffTotals, groupToolCalls, shortenArgument, toolRowLabel } from './toolRows';

function call(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
  status: ChatToolStatus = 'done'
): ChatToolCall {
  return { id, name, input, status };
}

/** A write that landed. Only the counts matter here; DiffView's tests cover the lines. */
function wrote(id: string, path: string, added: number, removed: number): ChatToolCall {
  const diff: ChatDiff = { path, operation: 'edit', added, removed, lines: [] };
  return { ...call(id, 'file_edit', { path }), diff };
}

describe('toolRowLabel', () => {
  it('names what the call acted on', () => {
    expect(toolRowLabel(call('1', 'file_read', { path: 'src/app.ts' }))).toBe('Read src/app.ts');
    expect(toolRowLabel(call('2', 'bash_execute', { command: 'pnpm lint' }))).toBe('Ran pnpm lint');
    expect(toolRowLabel(call('3', 'file_edit', { path: 'src/app.ts' }))).toBe('Edited src/app.ts');
  });

  it('names what a search looked for, not the folder it looked in', () => {
    const search = call('1', 'grep_search', { path: '/tmp/project', pattern: 'handleClick' });
    expect(toolRowLabel(search)).toBe('Searched for handleClick');
  });

  it('falls back to the bare phrase when there is nothing to name', () => {
    expect(toolRowLabel(call('1', 'file_read'))).toBe('Read a file');
    expect(toolRowLabel(call('2', 'bash_list'))).toBe('Listed background processes');
  });

  it('leaves a generation prompt out of the label rather than reciting it', () => {
    expect(toolRowLabel(call('1', 'generate_image', { prompt: 'a red bicycle at dusk' }))).toBe('Generated an image');
  });

  // session_send is the case this exists for: its only nameable argument is a uuid, so the row
  // would name nothing a reader recognises without the tool supplying the target's title.
  it('prefers a label the tool supplied over anything its arguments could say', () => {
    const sent = call('1', 'session_send', { session_id: 'b4e1', message: 'move MCP under Customize' });
    expect(toolRowLabel({ ...sent, label: 'Messaged @T27: move MCP under Customize' })).toBe(
      'Messaged @T27: move MCP under Customize'
    );
  });

  it('does not let a supplied label claim a call that failed or was refused', () => {
    const sent = call('1', 'session_send', { session_id: 'b4e1', message: 'hello' }, 'denied');
    expect(toolRowLabel({ ...sent, label: 'Messaged @T27: hello' })).toBe('Did not message a session');
    expect(toolRowLabel({ ...sent, status: 'error', label: 'Messaged @T27: hello' })).toBe(
      'Failed to message a session'
    );
  });

  it('says plainly that it does not know an unregistered tool', () => {
    expect(toolRowLabel(call('1', 'future_tool', { path: 'x.ts' }))).toBe('Ran future_tool x.ts');
  });

  it('does not claim a failed or refused call happened', () => {
    expect(toolRowLabel(call('1', 'bash_execute', { command: 'echo x' }, 'denied'))).toBe('Did not run echo x');
    expect(toolRowLabel(call('2', 'file_read', { path: 'gone.ts' }, 'error'))).toBe('Failed to read gone.ts');
    expect(toolRowLabel(call('3', 'generate_image', { prompt: 'a bicycle' }, 'error'))).toBe(
      'Failed to generate an image'
    );
  });
});

describe('shortenArgument', () => {
  it('keeps short arguments whole', () => {
    expect(shortenArgument('src/app.ts')).toBe('src/app.ts');
  });

  it('cuts a long path from the front, where the identity is not', () => {
    const long = '/Users/someone/Javascript/checkout/apps/desktop/src/chat/ToolCallList.tsx';
    expect(shortenArgument(long)).toBe('.../chat/ToolCallList.tsx');
  });

  it('cuts anything else from the back, where its meaning is not', () => {
    const command = `echo ${'x'.repeat(80)}`;
    const short = shortenArgument(command);
    expect(short.startsWith('echo xxx')).toBe(true);
    expect(short.endsWith('...')).toBe(true);
    expect(short.length).toBeLessThanOrEqual(56);
  });

  it('flattens a multi-line argument onto the one line it has', () => {
    expect(shortenArgument('git status\ngit diff')).toBe('git status git diff');
  });
});

describe('groupToolCalls', () => {
  it('collapses consecutive calls to the same tool, with a count', () => {
    const groups = groupToolCalls([
      call('1', 'bash_execute', { command: 'a' }),
      call('2', 'bash_execute', { command: 'b' }),
      call('3', 'bash_execute', { command: 'c' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Ran 3 commands');
    expect(groups[0].calls).toHaveLength(3);
  });

  it('folds a mixed run into one row, as a list in the order the tools ran', () => {
    const groups = groupToolCalls([
      call('1', 'bash_execute', { command: 'a' }),
      call('2', 'bash_execute', { command: 'b' }),
      call('3', 'file_read', { path: 'src/app.ts' }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('Ran 2 commands, read src/app.ts');
    expect(groups[0].calls).toHaveLength(3);
  });

  // The count is a claim about a run, so two reads with a command between them are two clauses
  // and never "Read 2 files" - that would report a sequence the model never performed.
  it('counts only calls that really were consecutive', () => {
    const groups = groupToolCalls([
      call('1', 'file_read', { path: 'a.ts' }),
      call('2', 'bash_execute', { command: 'ls' }),
      call('3', 'file_read', { path: 'b.ts' }),
    ]);

    expect(groups.map(group => group.label)).toEqual(['Read a.ts, ran ls, read b.ts']);
  });

  it('breaks a run rather than composing a label too long to name what it covers', () => {
    const groups = groupToolCalls([
      call('1', 'file_read', { path: 'a.ts' }),
      call('2', 'bash_execute', { command: 'ls' }),
      call('3', 'grep_search', { pattern: 'handleClick' }),
      call('4', 'glob_files', { pattern: '*.ts' }),
      call('5', 'file_read', { path: 'b.ts' }),
      call('6', 'bash_execute', { command: 'pwd' }),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0].label).toBe('Read a.ts, ran ls, searched for handleClick, searched for *.ts');
    expect(groups[1].label).toBe('Read b.ts, ran pwd');
  });

  it('leaves a call at the approval gate on its own row', () => {
    const groups = groupToolCalls([
      call('1', 'bash_execute', { command: 'a' }),
      call('2', 'bash_execute', { command: 'b' }, 'awaiting-approval'),
      call('3', 'bash_execute', { command: 'c' }),
    ]);

    expect(groups).toHaveLength(3);
    expect(groups[1].status).toBe('awaiting-approval');
    expect(groups[1].calls).toHaveLength(1);
  });

  // A count is written in the past tense, so a failure can never be inside one: "Read 2 files"
  // over a read that failed reports the opposite of what happened.
  it('reports a failure in a group rather than the successes around it', () => {
    const groups = groupToolCalls([
      call('1', 'file_read', { path: 'a.ts' }),
      call('2', 'file_read', { path: 'b.ts' }, 'error'),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].status).toBe('error');
    expect(groups[0].label).toBe('Read a.ts, failed to read b.ts');
  });

  it('keeps a refusal out of the count too', () => {
    const groups = groupToolCalls([
      call('1', 'bash_execute', { command: 'a' }),
      call('2', 'bash_execute', { command: 'b' }),
      call('3', 'bash_execute', { command: 'rm -rf /' }, 'denied'),
    ]);

    expect(groups[0].status).toBe('denied');
    expect(groups[0].label).toBe('Ran 2 commands, did not run rm -rf /');
  });

  it('keeps the spinner on a group whose last call is still running', () => {
    const groups = groupToolCalls([
      call('1', 'file_read', { path: 'a.ts' }),
      call('2', 'file_read', { path: 'b.ts' }, 'running'),
    ]);

    expect(groups[0].status).toBe('running');
  });

  // Beside the label, never inside it: the label is what the row ellipsizes, and these are the
  // two numbers a reader scanning a turn is counting on.
  it("carries the group's own total for the writes in it that landed", () => {
    const groups = groupToolCalls([
      call('1', 'bash_execute', { command: 'ls' }),
      wrote('2', '/repo/src/ChatService.ts', 9, 2),
    ]);

    expect(groups[0].label).toBe('Ran ls, edited /repo/src/ChatService.ts');
    expect(groups[0].diffstat).toEqual({ added: 9, removed: 2 });
  });

  it('sums the writes across a group rather than showing the last one', () => {
    const groups = groupToolCalls([wrote('1', '/repo/a.ts', 9, 2), wrote('2', '/repo/b.ts', 4, 0)]);

    expect(groups[0].label).toBe('Edited 2 files');
    expect(groups[0].diffstat).toEqual({ added: 13, removed: 2 });
  });

  // Every message stored before writes recorded a diff, and every group that wrote nothing.
  it('says nothing about lines when no call in the group has a diff', () => {
    const groups = groupToolCalls([call('1', 'file_edit', { path: 'a.ts' }), call('2', 'file_read', { path: 'b.ts' })]);

    expect(groups[0].label).toBe('Edited a.ts, read b.ts');
    expect(groups[0].diffstat).toBeUndefined();
    expect(diffTotals(groups[0].calls)).toBeUndefined();
  });

  // A create with nothing removed still has a total worth showing; only "no write at all" does
  // not, which is why this is not a truthiness check on the numbers.
  it('shows a total of zero removals rather than no total', () => {
    const groups = groupToolCalls([wrote('1', '/repo/new.ts', 28, 0)]);

    expect(groups[0].diffstat).toEqual({ added: 28, removed: 0 });
  });

  it('keys each group on its first call, so settling the rest does not remount it', () => {
    const first = groupToolCalls([call('1', 'file_read', {}, 'running')]);
    const second = groupToolCalls([call('1', 'file_read'), call('2', 'file_read', {}, 'running')]);

    expect(first[0].id).toBe('1');
    expect(second[0].id).toBe('1');
  });
});
