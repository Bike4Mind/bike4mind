import { describe, expect, it } from 'vitest';
import { SESSION_EXPIRED_STOP, type ChatHeldRelay, type ChatMessage, type ChatSessionSummary } from './chat';
import type { WorkerTask } from './orchestration';
import { pendingDecisionsInTree, pendingDecisionsOf, spawnPathOf } from './pendingDecisions';

const session = (id: string, parentId?: string, extra: Partial<ChatSessionSummary> = {}): ChatSessionSummary =>
  ({
    id,
    title: `Session ${id}`,
    mode: 'code',
    messageCount: 0,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    ...(parentId && { origin: { parentSessionId: parentId, seedPrompt: `seed ${id}` } }),
    ...extra,
  }) as ChatSessionSummary;

const at = '2026-10-01T00:00:00.000Z';
const prompt: ChatMessage = { id: 'p1', role: 'user', content: 'go', createdAt: at };
const reply = (fields: Partial<ChatMessage>): ChatMessage => ({
  id: 'r1',
  role: 'assistant',
  content: '',
  createdAt: at,
  ...fields,
});

const blockedOn = (decisionId: string): WorkerTask =>
  ({
    resolvedDecisions: [],
    state: {
      status: 'blocked',
      reason: 'Needs a choice',
      evidence: [],
      decision: {
        id: decisionId,
        askedAt: at,
        question: {
          header: 'Branch',
          question: 'Which branch?',
          options: [
            { label: 'main', description: 'The default' },
            { label: 'develop', description: 'The next release' },
          ],
        },
      },
    },
  }) as unknown as WorkerTask;

const held = (id: string): ChatHeldRelay => ({
  id,
  sessionId: 'a',
  text: 'please review',
  heldAt: at,
  reason: 'other-project',
  relay: { fromSessionId: 'x', fromTitle: 'Sender', kind: 'message' } as unknown as ChatHeldRelay['relay'],
});

describe('pendingDecisionsOf', () => {
  it('lists nothing for a session that waits on nothing', () => {
    expect(pendingDecisionsOf({ session: session('a'), messages: [prompt, reply({ content: 'done' })] })).toEqual([]);
  });

  it('derives an approval per call parked at the gate, flagging the ones that collect secrets', () => {
    const messages = [
      prompt,
      reply({
        toolCalls: [
          { id: 'c1', name: 'bash', input: {}, status: 'awaiting-approval', approvalId: 'ap1' },
          { id: 'c2', name: 'mcp_add_server', input: {}, status: 'awaiting-approval', approvalId: 'ap2' },
          { id: 'c3', name: 'read_file', input: {}, status: 'done' },
        ] as ChatMessage['toolCalls'],
      }),
    ];
    const decisions = pendingDecisionsOf({ session: session('a'), messages, processing: true });
    expect(decisions).toMatchObject([
      { kind: 'approval', sessionId: 'a', decisionId: 'approval:ap1', approvalId: 'ap1', collectsSecrets: false },
      { kind: 'approval', decisionId: 'approval:ap2', collectsSecrets: true },
    ]);
  });

  it('derives the task question and each held relay', () => {
    const decisions = pendingDecisionsOf({
      session: session('a', 'root', { workerTask: blockedOn('d1') }),
      held: [held('h1'), held('h2')],
    });
    expect(decisions.map(decision => `${decision.kind}:${decision.decisionId}`)).toEqual([
      'question:question:d1',
      'held-relay:held:h1',
      'held-relay:held:h2',
    ]);
  });

  it('drops a task question the user already resolved', () => {
    const task = { ...blockedOn('d1'), resolvedDecisions: ['d1'] } as WorkerTask;
    expect(pendingDecisionsOf({ session: session('a', 'root', { workerTask: task }) })).toEqual([]);
  });

  it('offers Retry on a failed last turn', () => {
    const messages = [prompt, reply({ error: 'Network down' })];
    expect(pendingDecisionsOf({ session: session('a'), messages })).toEqual([
      { kind: 'error', sessionId: 'a', decisionId: 'error:r1', messageId: 'r1', error: 'Network down' },
    ]);
  });

  it.each(['context_limit', 'aborted', 'server_credentials'])('offers no Retry for a %s stop', stopReason => {
    const messages = [prompt, reply({ error: 'failed', stopReason })];
    expect(pendingDecisionsOf({ session: session('a'), messages })).toEqual([]);
  });

  it.each(['tool_turn_limit', SESSION_EXPIRED_STOP])('offers Continue on a %s stop', stopReason => {
    const messages = [prompt, reply({ stopReason, ...(stopReason === SESSION_EXPIRED_STOP && { error: 'expired' }) })];
    expect(pendingDecisionsOf({ session: session('a'), messages })).toEqual([
      { kind: 'stopped', sessionId: 'a', decisionId: 'stopped:r1', messageId: 'r1', stopReason },
    ]);
  });

  it('offers neither while a turn is running', () => {
    expect(
      pendingDecisionsOf({ session: session('a'), messages: [prompt, reply({ error: 'x' })], processing: true })
    ).toEqual([]);
  });
});

describe('pendingDecisionsInTree', () => {
  const sessions = [
    session('root'),
    session('grandchild', 'child', { workerTask: blockedOn('d1') }),
    session('child', 'root'),
    session('quiet', 'root'),
    session('other', 'elsewhere'),
  ];

  it('keys every descendant with something open, shallowest first, and leaves the root out', () => {
    const tree = pendingDecisionsInTree(
      sessions,
      'root',
      new Map([
        ['root', { messages: [prompt, reply({ error: 'root failed' })] }],
        ['child', { held: [held('h1')] }],
        ['other', { held: [held('h2')] }],
      ])
    );
    expect([...tree.keys()]).toEqual(['child', 'grandchild']);
    expect(tree.get('grandchild')).toMatchObject([{ kind: 'question', sessionId: 'grandchild' }]);
  });

  it('leaves out an archived subtree', () => {
    const archived = sessions.map(entry => (entry.id === 'child' ? { ...entry, archived: true } : entry));
    expect(pendingDecisionsInTree(archived, 'root', new Map()).size).toBe(0);
  });
});

describe('spawnPathOf', () => {
  it('walks from the top of the tree down to the session', () => {
    const nodes = [{ id: 'grandchild', parentId: 'child' }, { id: 'child', parentId: 'root' }, { id: 'root' }];
    expect(spawnPathOf(nodes, 'grandchild').map(node => node.id)).toEqual(['root', 'child', 'grandchild']);
  });

  it('stops on a loop', () => {
    const nodes = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(spawnPathOf(nodes, 'a').map(node => node.id)).toEqual(['b', 'a']);
  });
});
