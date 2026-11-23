import { describe, expect, it } from 'vitest';
import type { ChatMessage, ChatSession } from './chat';
import { classifyMessagesOutcome, isUnfinishedOutcome, plainText, snippetOf, summarizeSession } from './agentOutcome';

function assistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'a', role: 'assistant', content: 'done', createdAt: '2026-01-01T00:00:00.000Z', ...overrides };
}

describe('isUnfinishedOutcome', () => {
  it.each([
    ['finished', false],
    ['no-reply', false],
    ['max-tokens', false],
    ['failed', true],
    ['aborted', true],
    ['turn-budget', true],
    ['context-limit', true],
  ] as const)('%s -> %s', (outcome, expected) => {
    expect(isUnfinishedOutcome(outcome)).toBe(expected);
  });

  it('is false without an outcome', () => {
    expect(isUnfinishedOutcome(undefined)).toBe(false);
  });
});

describe('classifyMessagesOutcome', () => {
  it('is no-reply without an assistant message', () => {
    expect(classifyMessagesOutcome([])).toBe('no-reply');
    expect(classifyMessagesOutcome([{ ...assistant(), role: 'user' }])).toBe('no-reply');
  });

  it('classifies the last assistant message', () => {
    expect(classifyMessagesOutcome([assistant({ error: 'boom' })])).toBe('failed');
    expect(classifyMessagesOutcome([assistant({ stopReason: 'aborted' })])).toBe('aborted');
    expect(classifyMessagesOutcome([assistant({ stopReason: 'context_limit' })])).toBe('context-limit');
    expect(classifyMessagesOutcome([assistant({ stopReason: 'max_tokens' })])).toBe('max-tokens');
    expect(classifyMessagesOutcome([assistant()])).toBe('finished');
  });

  it('ignores an earlier failed turn once a later one is clean', () => {
    expect(classifyMessagesOutcome([assistant({ id: 'a1', error: 'boom' }), assistant({ id: 'a2' })])).toBe('finished');
  });
});

describe('snippetOf', () => {
  it('collapses whitespace and trims', () => {
    expect(snippetOf('  a\n\nb  ')).toBe('a b');
  });

  it('cuts to the budget with a trailing ellipsis', () => {
    const snippet = snippetOf('x'.repeat(200));
    expect(snippet).toHaveLength(160);
    expect(snippet.endsWith('...')).toBe(true);
  });

  it('leaves empty text empty', () => {
    expect(snippetOf('')).toBe('');
  });
});

describe('summarizeSession lastSnippet', () => {
  const session = (messages: ChatMessage[]) =>
    ({
      id: 's',
      title: 't',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      messages,
    }) as ChatSession;
  const round = (text: string) => ({ text, toolCallIds: [] });

  it('takes the last round that said anything, not the opening narration', () => {
    const reply = assistant({
      content: 'Let me look at the files. Tests pass. Added the chip and its tests.',
      rounds: [
        round('Let me look at the files.'),
        round('Tests pass.'),
        round('Added the chip and its tests.'),
        round('  '),
      ],
    });
    expect(summarizeSession(session([reply])).lastSnippet).toBe('Added the chip and its tests.');
  });

  it('falls back to the content when no round has text', () => {
    expect(summarizeSession(session([assistant({ content: 'Plain reply' })])).lastSnippet).toBe('Plain reply');
    expect(summarizeSession(session([assistant({ content: 'Only tools', rounds: [round('')] })])).lastSnippet).toBe(
      'Only tools'
    );
  });
});

describe('plainText', () => {
  it('drops markdown syntax and keeps the words', () => {
    expect(plainText('## Verdict: **ship with nits**')).toBe('Verdict: ship with nits');
    expect(plainText('Wired into `Composer.tsx` and *tested*')).toBe('Wired into Composer.tsx and tested');
    expect(plainText('- one\n> two\n1. three')).toBe('one\ntwo\nthree');
    expect(plainText('See [the PR](https://example.com/pr/1).')).toBe('See the PR.');
    expect(plainText('```ts\nconst a = 2 * 3 * 4;\n```')).toBe('const a = 2 * 3 * 4;\n');
  });
});

describe('summarizeSession plan', () => {
  const session = (messages: ChatMessage[]) =>
    ({ id: 's', title: 't', createdAt: '', updatedAt: '', model: 'm', messages }) as unknown as ChatSession;
  const plan = (id: string, statuses: string[], status: 'done' | 'error' = 'done'): ChatMessage =>
    assistant({
      id,
      toolCalls: [
        {
          id: `c-${id}`,
          name: 'todo_write',
          input: { todos: statuses.map((s, i) => ({ content: `Step ${i + 1}`, status: s })) },
          status,
        },
      ],
    });

  it('summarises the latest plan as done, total, current and next', () => {
    expect(summarizeSession(session([plan('a1', ['completed', 'in_progress', 'pending'])])).plan).toEqual({
      done: 1,
      total: 3,
      current: 'Step 2',
      next: 'Step 3',
    });
  });

  it('has no plan key without a plan, with an empty plan, or when the plan call failed', () => {
    expect(summarizeSession(session([assistant()]))).not.toHaveProperty('plan');
    expect(summarizeSession(session([plan('a1', [])]))).not.toHaveProperty('plan');
    expect(summarizeSession(session([plan('a1', ['pending'], 'error')]))).not.toHaveProperty('plan');
  });

  it('reads an imported Claude Code task stream', () => {
    const task = (id: string, name: string, input: Record<string, unknown>): ChatMessage =>
      assistant({ id, toolCalls: [{ id: `c-${id}`, name, input, status: 'done' }] });
    const summary = summarizeSession(
      session([
        task('t1', 'TaskCreate', { subject: 'One', description: 'd' }),
        task('t2', 'TaskCreate', { subject: 'Two', description: 'd' }),
        task('t3', 'TaskUpdate', { taskId: '1', status: 'completed' }),
      ])
    );
    expect(summary.plan).toMatchObject({ done: 1, total: 2 });
  });
});
