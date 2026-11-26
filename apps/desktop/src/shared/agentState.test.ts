import { describe, expect, it } from 'vitest';
import { deriveTaskAgentState, isUpdateOnlyTask, MISSING_TASK_RESULT_REASON } from './agentState';
import { classifyMessagesOutcome, isUnfinishedOutcome, plainText, snippetOf, summarizeSession } from './agentOutcome';
import { PERSONA_NAMES, assignPersonas, distinctTitle, epithetFor, type PersonaSubject } from './agentPersona';
import type { WorkerTask } from './orchestration';
import type { ChatMessage, ChatSession } from './chat';

describe('agentState', () => {
  const completed = (accepted: boolean): WorkerTask['state'] => ({
    status: 'completed',
    accepted,
    changedPaths: [],
    verification: [],
    unmetCriteria: [],
    handoff: 'Ready',
  });
  const states: [string, WorkerTask['state'], boolean][] = [
    ['accepted', completed(true), true],
    ['unaccepted', completed(false), false],
    ['missing result', { status: 'blocked', reason: MISSING_TASK_RESULT_REASON, evidence: [] }, true],
    ['blocker', { status: 'blocked', reason: 'Missing access', evidence: [] }, false],
    [
      'decision',
      {
        status: 'blocked',
        reason: MISSING_TASK_RESULT_REASON,
        evidence: [],
        decision: {
          id: 'decision',
          askedAt: '2026-11-19',
          question: {
            header: 'Branch',
            question: 'Which branch?',
            options: [
              { label: 'main', description: '' },
              { label: 'develop', description: '' },
            ],
          },
        },
      },
      false,
    ],
  ];

  describe('waiting on background jobs', () => {
    const jobs = { running: 2, label: 'pnpm test' };

    it('shows a plain agent whose turn ended with running jobs as waiting, not done', () => {
      expect(deriveTaskAgentState({ lastOutcome: 'finished' }, 'done', jobs)).toBe('waiting');
      expect(deriveTaskAgentState({ lastOutcome: 'finished' }, undefined, jobs)).toBe('waiting');
      expect(deriveTaskAgentState({ lastOutcome: 'finished' }, 'done')).toBe('done');
    });

    it('shows a turn-budget stop as paused once its jobs are gone', () => {
      expect(deriveTaskAgentState({ lastOutcome: 'turn-budget' }, 'done')).toBe('paused');
      expect(deriveTaskAgentState({ lastOutcome: 'turn-budget' }, 'done', jobs)).toBe('waiting');
    });

    it('keeps an accepted worker task waiting while its jobs run', () => {
      const workerTask = { state: completed(true), attentionViewed: true } as WorkerTask;
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'done', jobs)).toBe('waiting');
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'done')).toBe('done');
    });

    // A pending decision reaches here as 'needs-action' (SessionActivity owns attention), and that outranks jobs.
    it('lets a decision the user owes outrank running jobs', () => {
      const workerTask = { state: completed(false), attentionViewed: false } as WorkerTask;
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'needs-action', jobs)).toBe('needs-you');
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'done', jobs)).toBe('waiting');
    });

    it('lets a live turn outrank running jobs', () => {
      expect(deriveTaskAgentState({ lastOutcome: 'finished' }, 'processing', jobs)).toBe('working');
    });
  });

  describe.each(states)('%s attention', (_label, state, updateOnly) => {
    it.each([true, false, undefined])('preserves required decisions when attentionViewed=%s', attentionViewed => {
      const workerTask = { state, attentionViewed } as WorkerTask;
      expect(isUpdateOnlyTask(state)).toBe(updateOnly);
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, undefined)).toBe('done');
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'done')).toBe('done');
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'needs-action')).toBe('needs-you');
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'finished' }, 'processing')).toBe('working');
    });
  });

  it('preserves task completion, cancellation and runtime outcome states without inventing attention', () => {
    expect(deriveTaskAgentState({ workerTask: { state: completed(false) } as WorkerTask }, undefined)).toBe('done');
    const workerTask = { state: { status: 'canceled', reason: 'Stopped' } } as WorkerTask;
    expect(deriveTaskAgentState({ workerTask }, undefined)).toBe('stopped');
    expect(deriveTaskAgentState({ workerTask }, 'processing')).toBe('working');
    expect(deriveTaskAgentState({ workerTask }, 'needs-action')).toBe('needs-you');
    for (const state of ['queued', 'running', 'blocked', 'paused', 'escalated'] as const) {
      const workerTask = { state: { status: state } } as WorkerTask;
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'failed' }, undefined)).toBe('failed');
      expect(deriveTaskAgentState({ workerTask, lastOutcome: 'aborted' }, undefined)).toBe('stopped');
      expect(deriveTaskAgentState({ workerTask }, undefined)).toBe('idle');
    }
  });
});

describe('agentOutcome', () => {
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
      expect(classifyMessagesOutcome([assistant({ id: 'a1', error: 'boom' }), assistant({ id: 'a2' })])).toBe(
        'finished'
      );
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
});

describe('agentPersona', () => {
  const agentFixture = (id: string, extra: Partial<PersonaSubject> = {}): PersonaSubject => ({
    id,
    title: `Agent ${id}`,
    seedPrompt: '',
    createdAt: '2026-10-01T00:00:00.000Z',
    ...extra,
  });

  describe('distinctTitle', () => {
    it('strips the longest shared prefix ending at a separator', () => {
      const titles = ['Desktop audit: unused files', 'Desktop audit: large files', 'Other work'];
      expect(distinctTitle(titles[0] ?? '', titles)).toBe('unused files');
      expect(distinctTitle(titles[1] ?? '', titles)).toBe('large files');
    });

    it('handles dash and pipe separators and prefers the longest shared prefix', () => {
      const titles = ['Audit - desktop - unused', 'Audit - desktop - large', 'Audit - web'];
      expect(distinctTitle('Audit - desktop - unused', titles)).toBe('unused');
      expect(distinctTitle('Audit - web', titles)).toBe('web');
      const piped = ['Repo | alpha', 'Repo | beta'];
      expect(distinctTitle('Repo | alpha', piped)).toBe('alpha');
    });

    it('leaves a title alone when nothing is shared', () => {
      const titles = ['Fix login: now', 'Write docs: later'];
      expect(distinctTitle('Fix login: now', titles)).toBe('Fix login: now');
      expect(distinctTitle('Solo', ['Solo'])).toBe('Solo');
    });

    it('does not treat a prefix that is not separator-terminated as shared', () => {
      const titles = ['Desktop audit one', 'Desktop audit two'];
      expect(distinctTitle('Desktop audit one', titles)).toBe('Desktop audit one');
    });

    it('falls back to the full title when stripping would leave nothing', () => {
      const titles = ['Audit:', 'Audit: more'];
      expect(distinctTitle('Audit:', titles)).toBe('Audit:');
      expect(distinctTitle('Audit:  ', ['Audit:  ', 'Audit: more'])).toBe('Audit:  ');
    });
  });

  describe('epithetFor', () => {
    it.each([
      ['Check permissions', '', 'Warden'],
      ['Update the README', '', 'Scribe'],
      ['Fix the bug', '', 'Tinkerer'],
      ['Largest files', '', 'Cartographer'],
      ['Find stale branches', '', 'Seeker'],
      ['Say hello', 'be friendly', 'Wanderer'],
    ])('%s -> %s', (title, seed, expected) => {
      expect(epithetFor(title, seed)).toBe(expected);
    });

    it('matches case-insensitively and reads the seed prompt too', () => {
      expect(epithetFor('Task', 'REVIEW the diff')).toBe('Warden');
    });

    it('lets the title decide before the seed prompt, whose "report back" boilerplate would make every agent a Scribe', () => {
      const brief = 'Look through the repo, then report back with a short summary.';
      expect(epithetFor('Map top-level folders', brief)).toBe('Cartographer');
      expect(epithetFor('Find Node/pnpm versions', brief)).toBe('Seeker');
      expect(epithetFor('Say hello', brief)).toBe('Scribe');
    });

    it('applies precedence in the stated order', () => {
      expect(epithetFor('Review and document the tests', '')).toBe('Warden');
      expect(epithetFor('Document and fix', '')).toBe('Scribe');
      expect(epithetFor('Fix the structure', '')).toBe('Tinkerer');
      expect(epithetFor('List unused files', '')).toBe('Cartographer');
    });
  });

  describe('assignPersonas', () => {
    const roster = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        agentFixture(`session-${index}`, {
          createdAt: `2026-10-01T00:00:${String(index).padStart(2, '0')}.000Z`,
        })
      );

    it('has a pool of 48 unique ASCII names', () => {
      expect(PERSONA_NAMES).toHaveLength(48);
      expect(new Set(PERSONA_NAMES).size).toBe(48);
      expect(PERSONA_NAMES.every(name => /^[A-Za-z]+$/.test(name))).toBe(true);
    });

    it('is deterministic regardless of input order', () => {
      const agents = roster(12);
      const first = assignPersonas(agents);
      const second = assignPersonas([...agents].reverse());
      expect(Object.fromEntries(second)).toEqual(Object.fromEntries(first));
    });

    it('adds the title part that differs from its siblings as shortTitle', () => {
      const personas = assignPersonas([
        agentFixture('a', { title: 'Desktop audit: unused files' }),
        agentFixture('b', { title: 'Desktop audit: large files' }),
        agentFixture('c', { title: 'Standalone' }),
      ]);
      expect(personas.get('a')?.shortTitle).toBe('unused files');
      expect(personas.get('b')?.shortTitle).toBe('large files');
      expect(personas.get('c')?.shortTitle).toBe('Standalone');
    });

    it('gives a 12-agent roster 12 distinct one-word names', () => {
      const personas = [...assignPersonas(roster(12)).values()];
      expect(new Set(personas.map(persona => persona.name)).size).toBe(12);
      for (const persona of personas) expect(persona.label).toBe(persona.name);
    });

    it('keeps existing names when a newer agent joins', () => {
      const agents = roster(12);
      const before = assignPersonas(agents);
      const after = assignPersonas([...agents, agentFixture('session-new', { createdAt: '2026-10-02T00:00:00.000Z' })]);
      for (const agent of agents) expect(after.get(agent.id)?.name).toBe(before.get(agent.id)?.name);
    });

    it('breaks createdAt ties by id', () => {
      const same = '2026-10-01T00:00:00.000Z';
      const personas = assignPersonas(['b', 'a', 'c'].map(id => agentFixture(id, { createdAt: same })));
      expect(new Set([...personas.values()].map(persona => persona.name)).size).toBe(3);
    });

    it('terminates when the roster outgrows the name pool', () => {
      expect(assignPersonas(roster(60)).size).toBe(60);
    });
  });
});
