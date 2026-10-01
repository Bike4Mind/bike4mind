import type { ChatMessage, ChatToolCall } from '@shared/chat';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PRUNING_POLICY,
  findStaleResults,
  historyRounds,
  stalePlaceholder,
  toolResultContent,
  type PruningPolicy,
} from './contextPruning';

let nextId = 0;

function call(
  name: string,
  input: Record<string, unknown>,
  preview: string,
  extra: Partial<ChatToolCall> = {}
): ChatToolCall {
  nextId += 1;
  return { id: `call_${nextId}`, name, input, status: 'done', preview, ...extra };
}

/** A whole-file read result: numbered rows and no trailer. */
function wholeRead(path: string, chars: number): ChatToolCall {
  return call('file_read', { path }, `1\t${'x'.repeat(chars)}`);
}

function rangeRead(path: string, first: number, last: number, chars: number): ChatToolCall {
  const trailer = `[Lines ${first}-${last} of 900. Continue with offset ${last + 1}. grep_search with context is usually cheaper than paging to find a spot.]`;
  return call(
    'file_read',
    { path, offset: first, limit: last - first + 1 },
    `${first}\t${'x'.repeat(chars)}\n\n${trailer}`
  );
}

function edit(path: string): ChatToolCall {
  return call('file_edit', { path, oldText: 'a', newText: 'b' }, 'Written.');
}

function rewrite(path: string): ChatToolCall {
  return call('file_write', { path, content: 'b' }, 'Written.');
}

function glob(): ChatToolCall {
  return call('glob_files', { pattern: '*' }, 'a.ts');
}

/** Everything that is stale gets cleared, so single-supersession tests read the rule directly. */
const EAGER: PruningPolicy = { minChars: 0, minShare: 0, exemptRounds: 2 };

describe('findStaleResults', () => {
  it('keeps a read the model later changed with file_edit', () => {
    const read = wholeRead('/p/a.ts', 100);
    const result = findStaleResults([[read], [edit('/p/a.ts')], [edit('/p/a.ts')], [glob()], [glob()]], EAGER);
    expect(result).toEqual({ clearIds: [], pendingChars: 0 });
  });

  it('clears a read the model later rewrote with file_write', () => {
    const read = wholeRead('/p/a.ts', 100);
    const result = findStaleResults([[read], [rewrite('/p/a.ts')], [glob()], [glob()]], EAGER);
    expect(result.clearIds).toEqual([read.id]);
  });

  it('clears a read covered by a wider re-read', () => {
    const narrow = rangeRead('/p/a.ts', 100, 200, 100);
    const result = findStaleResults([[narrow], [rangeRead('/p/a.ts', 50, 400, 100)], [glob()], [glob()]], EAGER);
    expect(result.clearIds).toEqual([narrow.id]);
  });

  it('clears a range read covered by a later whole-file read', () => {
    const narrow = rangeRead('/p/a.ts', 100, 200, 100);
    expect(findStaleResults([[narrow], [wholeRead('/p/a.ts', 100)], [glob()], [glob()]], EAGER).clearIds).toEqual([
      narrow.id,
    ]);
  });

  it('keeps a read when the later read is narrower', () => {
    const wide = rangeRead('/p/a.ts', 1, 400, 100);
    const result = findStaleResults([[wide], [rangeRead('/p/a.ts', 100, 200, 100)], [glob()], [glob()]], EAGER);
    expect(result.clearIds).toEqual([]);
    expect(result.pendingChars).toBe(0);
  });

  it('keeps a read when the later call touched another file, failed, or was declined', () => {
    const read = wholeRead('/p/a.ts', 100);
    const rounds = [
      [read],
      [rewrite('/p/b.ts'), call('file_edit', { path: '/p/a.ts' }, '', { status: 'error', error: 'no match' })],
      [call('file_write', { path: '/p/a.ts' }, '', { status: 'denied', error: 'declined' })],
      [glob()],
      [glob()],
    ];
    expect(findStaleResults(rounds, EAGER).clearIds).toEqual([]);
  });

  it('never clears error results, explore reports or bash output', () => {
    const failed = call('file_read', { path: '/p/a.ts' }, '', { status: 'error', error: 'ENOENT' });
    const report = call('explore', { question: 'where?' }, 'report');
    const bash = call('bash_execute', { command: 'ls' }, 'a.ts');
    const rounds = [[failed, report, bash], [rewrite('/p/a.ts'), wholeRead('/p/a.ts', 10)], [glob()], [glob()]];
    expect(findStaleResults(rounds, EAGER).clearIds).toEqual([]);
  });

  it('exempts the current round and the one before it', () => {
    const older = wholeRead('/p/a.ts', 100);
    const previous = wholeRead('/p/b.ts', 100);
    const current = wholeRead('/p/c.ts', 100);
    const rounds = [[older], [previous], [current, rewrite('/p/a.ts'), rewrite('/p/b.ts'), rewrite('/p/c.ts')]];
    expect(findStaleResults(rounds, EAGER).clearIds).toEqual([older.id]);
  });

  it('counts only rounds that ran tools toward the exemption', () => {
    const read = wholeRead('/p/a.ts', 100);
    expect(findStaleResults([[read], [], [rewrite('/p/a.ts')], []], EAGER).clearIds).toEqual([]);
  });

  it('matches paths after normalizing them', () => {
    const read = wholeRead('/p/src/../a.ts', 100);
    expect(findStaleResults([[read], [rewrite('/p/a.ts')], [glob()], [glob()]], EAGER).clearIds).toEqual([read.id]);
  });

  describe('batching', () => {
    it('tallies stale results but clears nothing below the character floor', () => {
      const read = wholeRead('/p/a.ts', 30_000);
      const result = findStaleResults([[read], [rewrite('/p/a.ts')], [glob()], [glob()]]);
      expect(result.clearIds).toEqual([]);
      expect(result.pendingChars).toBe(toolResultContent(read).length);
    });

    it('clears every stale result at once when the tally passes the floor', () => {
      const a = wholeRead('/p/a.ts', 25_000);
      const b = wholeRead('/p/b.ts', 25_000);
      const rounds = [[a], [b], [rewrite('/p/a.ts'), rewrite('/p/b.ts')], [glob()], [glob()]];
      const result = findStaleResults(rounds);
      expect(result.clearIds).toEqual([a.id, b.id]);
      expect(result.pendingChars).toBeGreaterThanOrEqual(DEFAULT_PRUNING_POLICY.minChars);
    });

    it('holds a batch whose rewrite tail is too large for it to repay', () => {
      const a = wholeRead('/p/a.ts', 25_000);
      const b = wholeRead('/p/b.ts', 25_000);
      const fresh = [1, 2, 3, 4, 5].map(n => wholeRead(`/p/fresh${n}.ts`, 25_000));
      const rounds = [[a], [b], fresh, [rewrite('/p/a.ts'), rewrite('/p/b.ts')], [glob()], [glob()]];
      const result = findStaleResults(rounds);
      expect(result.pendingChars).toBeGreaterThanOrEqual(DEFAULT_PRUNING_POLICY.minChars);
      expect(result.clearIds).toEqual([]);
    });
  });

  it('is sticky: a cleared result stays cleared once the tally is back to zero', () => {
    const a = wholeRead('/p/a.ts', 25_000);
    const b = wholeRead('/p/b.ts', 25_000);
    const rounds = [[a], [b], [rewrite('/p/a.ts'), rewrite('/p/b.ts')], [glob()], [glob()]];
    for (const id of findStaleResults(rounds).clearIds) {
      const target = rounds.flat().find(entry => entry.id === id);
      if (target) target.cleared = true;
    }
    const placeholder = toolResultContent(a);

    const after = findStaleResults([...rounds, [glob()], [glob()]]);
    expect(after).toEqual({ clearIds: [], pendingChars: 0 });
    expect(toolResultContent(a)).toBe(placeholder);
    expect(a.preview).toMatch(/^1\tx/);
  });

  it('gives the same answer for the same history', () => {
    const build = () => {
      nextId = 1000;
      const a = wholeRead('/p/a.ts', 25_000);
      const b = rangeRead('/p/b.ts', 10, 90, 25_000);
      return [[a], [b], [rewrite('/p/a.ts'), rangeRead('/p/b.ts', 1, 200, 50)], [glob()], [glob()]];
    };
    const first = findStaleResults(build());
    expect(first.clearIds).toHaveLength(2);
    expect(findStaleResults(build())).toEqual(first);
  });
});

describe('stalePlaceholder', () => {
  it('names the path and the lines the read returned', () => {
    expect(stalePlaceholder(rangeRead('/p/a.ts', 10, 90, 5))).toBe(
      '[stale: /p/a.ts lines 10-90 was read here; the file was rewritten or re-read later. Read it again if you need it.]'
    );
  });

  it('names just the path for a whole-file read', () => {
    expect(stalePlaceholder(wholeRead('/p/a.ts', 5))).toBe(
      '[stale: /p/a.ts was read here; the file was rewritten or re-read later. Read it again if you need it.]'
    );
  });

  it('is what the model is sent for a cleared call, while an error still wins', () => {
    const read = { ...wholeRead('/p/a.ts', 5), cleared: true as const };
    expect(toolResultContent(read)).toBe(stalePlaceholder(read));
    expect(toolResultContent({ ...read, error: 'boom' })).toBe('boom');
  });
});

describe('historyRounds', () => {
  it('splits a stored reply back into its rounds and treats an unrounded one as a single round', () => {
    const [a, b, c, d] = [glob(), glob(), glob(), glob()];
    const messages: ChatMessage[] = [
      { id: 'm1', role: 'user', content: 'go', createdAt: '' },
      {
        id: 'm2',
        role: 'assistant',
        content: '',
        createdAt: '',
        toolCalls: [a, b, c],
        rounds: [
          { text: '', toolCallIds: [a.id] },
          { text: '', toolCallIds: [b.id, c.id] },
          { text: 'done', toolCallIds: [] },
        ],
      },
      { id: 'm3', role: 'assistant', content: '', createdAt: '', toolCalls: [d] },
    ];
    expect(historyRounds(messages).map(round => round.map(entry => entry.id))).toEqual([[a.id], [b.id, c.id], [d.id]]);
  });
});

describe('findStaleResults with apply_patch', () => {
  const patch = (...body: string[]): ChatToolCall =>
    call('apply_patch', { patchText: ['*** Begin Patch', ...body, '*** End Patch'].join('\n') }, 'Applied patch');
  const staleAfter = (...later: ChatToolCall[]) => {
    const read = wholeRead('/p/a.ts', 100);
    return findStaleResults([[read], ...later.map(entry => [entry]), [glob()], [glob()]], EAGER).clearIds.includes(
      read.id
    );
  };

  it('keeps a read the model later updated in place', () => {
    expect(staleAfter(patch('*** Update File: /p/a.ts', '@@', '-a', '+b'))).toBe(false);
  });

  it('clears a read of a file the patch added or deleted', () => {
    expect(staleAfter(patch('*** Add File: /p/a.ts', '+b'))).toBe(true);
    expect(staleAfter(patch('*** Delete File: /p/a.ts'))).toBe(true);
  });

  it('clears a read of either end of a move', () => {
    expect(staleAfter(patch('*** Update File: /p/a.ts', '*** Move to: /p/b.ts', '@@', '-a', '+b'))).toBe(true);
    expect(staleAfter(patch('*** Update File: /p/z.ts', '*** Move to: /p/a.ts', '@@', '-a', '+b'))).toBe(true);
  });

  it('finds the file among several in one patch, and ignores other files', () => {
    expect(staleAfter(patch('*** Update File: /p/x.ts', '@@', '-a', '+b', '*** Delete File: /p/a.ts'))).toBe(true);
    expect(staleAfter(patch('*** Add File: /p/other.ts', '+b', '*** Update File: /p/a.ts', '@@', '-a', '+b'))).toBe(
      false
    );
  });

  it('ignores a patch that failed', () => {
    const failed = { ...patch('*** Delete File: /p/a.ts'), status: 'error' as const, error: 'nope' };
    expect(staleAfter(failed)).toBe(false);
  });
});
