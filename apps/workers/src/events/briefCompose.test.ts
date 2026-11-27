import { describe, expect, it, vi } from 'vitest';
import type { IAssistantBrief } from '@bike4mind/database';
import { composeBrief, type BriefComposeDeps } from './briefCompose';

const brief = (overrides: Partial<IAssistantBrief> = {}): IAssistantBrief =>
  ({
    _id: 'b1',
    userId: 'u1',
    status: 'composing',
    periodStart: new Date('2026-11-16T00:00:00Z'),
    periodEnd: new Date('2026-11-17T00:00:00Z'),
    ...overrides,
  }) as unknown as IAssistantBrief;

const activeActivity = {
  periodStart: new Date('2026-11-16T00:00:00Z'),
  periodEnd: new Date('2026-11-17T00:00:00Z'),
  runs: [{ id: 'r1', query: 'q', status: 'completed', finishedAt: undefined, errorMessage: undefined }],
  approvals: [{ questId: 'q1', sessionId: 's1', pendingActionTs: 5, tool: 'send_reply', summary: '{}' }],
  questions: [],
  emails: [],
  delegations: [],
  reminders: [],
  obligations: [],
};

function makeDeps(overrides: Partial<BriefComposeDeps> = {}) {
  const deps = {
    now: () => new Date('2026-11-17T01:00:00Z'),
    users: { findById: vi.fn().mockResolvedValue({ id: 'u1' }) },
    briefs: {
      findById: vi.fn().mockResolvedValue(brief()),
      markReady: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
      discardComposing: vi.fn().mockResolvedValue(true),
      removeEmailSourcedItems: vi.fn().mockResolvedValue(0),
      markRemindersSurfaced: vi.fn().mockResolvedValue(undefined),
    },
    loadActivity: vi.fn().mockResolvedValue(activeActivity),
    canCompose: vi.fn().mockResolvedValue('ok'),
    complete: vi.fn().mockResolvedValue(JSON.stringify({ headline: 'Done.', handled: ['Did a thing.'] })),
    loadInstructions: vi.fn().mockResolvedValue([]),
    push: vi.fn().mockResolvedValue(undefined),
    notifyHeldRuns: vi.fn().mockResolvedValue(undefined),
    emails: {
      markBriefed: vi.fn().mockResolvedValue(0),
      storedEmailIds: vi.fn((_userId: string, ids: string[]) => Promise.resolve(ids)),
    },
    delegations: { markBriefed: vi.fn().mockResolvedValue(0) },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as BriefComposeDeps & {
    briefs: {
      markReady: ReturnType<typeof vi.fn>;
      markFailed: ReturnType<typeof vi.fn>;
      discardComposing: ReturnType<typeof vi.fn>;
      removeEmailSourcedItems: ReturnType<typeof vi.fn>;
      markRemindersSurfaced: ReturnType<typeof vi.fn>;
    };
    push: ReturnType<typeof vi.fn>;
    notifyHeldRuns: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    emails: { markBriefed: ReturnType<typeof vi.fn>; storedEmailIds: ReturnType<typeof vi.fn> };
    delegations: { markBriefed: ReturnType<typeof vi.fn> };
    logger: { error: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
  };
  return deps;
}

describe('composeBrief', () => {
  const reminders = [{ briefId: 'b0', decisionId: 'fu-reminder-1', text: 'Call the vendor' }];
  const reminderOnly = { ...activeActivity, runs: [], approvals: [], reminders };

  it('lists due reminders without a model call and marks them surfaced only after the brief is stored', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(reminderOnly) });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.briefs.discardComposing).not.toHaveBeenCalled();
    const [, composed] = deps.briefs.markReady.mock.calls[0];
    expect(composed.happened).toEqual([{ id: 'h1', text: 'Reminder: Call the vendor' }]);
    expect(deps.briefs.markRemindersSurfaced).toHaveBeenCalledWith('u1', reminders, expect.any(Date));
    expect(deps.briefs.markReady.mock.invocationCallOrder[0]).toBeLessThan(
      deps.briefs.markRemindersSurfaced.mock.invocationCallOrder[0]
    );
    expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ body: 'You have a reminder.' }));
  });

  it('leaves reminders unmarked when the brief was not stored, and swallows a failed mark', async () => {
    const notStored = makeDeps({ loadActivity: vi.fn().mockResolvedValue(reminderOnly) });
    notStored.briefs.markReady.mockResolvedValue(false);
    await composeBrief(notStored, { briefId: 'b1', userId: 'u1' });
    expect(notStored.briefs.markRemindersSurfaced).not.toHaveBeenCalled();

    const failing = makeDeps({ loadActivity: vi.fn().mockResolvedValue(reminderOnly) });
    failing.briefs.markRemindersSurfaced.mockRejectedValue(new Error('db down'));
    await composeBrief(failing, { briefId: 'b1', userId: 'u1' });
    expect(failing.briefs.markFailed).not.toHaveBeenCalled();
    expect(failing.push).toHaveBeenCalled();
    expect(failing.logger.warn).toHaveBeenCalled();
  });

  it('composes, stores and pushes brief_ready with the brief id', async () => {
    const deps = makeDeps();
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    expect(deps.briefs.markReady).toHaveBeenCalledOnce();
    const stored = deps.briefs.markReady.mock.calls[0][1];
    expect(stored.decisions[0].approval).toEqual({ questId: 'q1', sessionId: 's1', pendingActionTs: 5 });
    expect(deps.push).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u1',
        category: 'brief_ready',
        briefId: 'b1',
        body: 'An agent wants to run send_reply and is waiting for your confirmation.',
        briefAction: 'approval',
      })
    );
  });

  it('names the action kind on the push only when the brief holds exactly one decision', async () => {
    const approval = (n: number) => ({ ...activeActivity.approvals[0], questId: `q${n}`, pendingActionTs: n });
    const question = { questId: 'qq1', sessionId: 's1', reply: 'Which venue?', options: ['Hall', 'Garden'] };
    const cases = [
      { approvals: [], questions: [], expected: undefined },
      { approvals: [approval(1)], questions: [], expected: 'approval' },
      { approvals: [], questions: [question], expected: 'question' },
      { approvals: [approval(1), approval(2)], questions: [], expected: undefined },
      { approvals: [approval(1)], questions: [question], expected: undefined },
    ];
    for (const { approvals, questions, expected } of cases) {
      const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, approvals, questions }) });
      await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
      expect(deps.push.mock.calls[0][0].briefAction).toBe(expected);
    }
  });

  it('shows what the inline action answers, and drops the action when it cannot', async () => {
    const question = { questId: 'qq1', sessionId: 's1', reply: 'Which   venue\nfor Friday?', options: ['Hall'] };
    const asked = makeDeps({
      loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, approvals: [], questions: [question] }),
    });
    await composeBrief(asked, { briefId: 'b1', userId: 'u1' });
    expect(asked.push.mock.calls[0][0]).toMatchObject({
      body: 'Your agent asks: Which venue for Friday?',
      briefAction: 'question',
    });

    const silent = makeDeps({
      loadActivity: vi
        .fn()
        .mockResolvedValue({ ...activeActivity, approvals: [], questions: [{ ...question, reply: ' ' }] }),
    });
    await composeBrief(silent, { briefId: 'b1', userId: 'u1' });
    expect(silent.push.mock.calls[0][0].body).toBe('1 decision needs you.');
    expect(silent.push.mock.calls[0][0]).not.toHaveProperty('briefAction');
  });

  it('stores a triaged email decision with its draft reply and no approval reference', async () => {
    const draftReply = { to: 'vendor@example.com', subject: 'Re: Renewal', body: 'Renewing at the quoted rate.' };
    const deps = makeDeps({
      loadActivity: vi.fn().mockResolvedValue({
        ...activeActivity,
        runs: [],
        approvals: [],
        emails: [{ emailId: 'e1', kind: 'decision', summary: 'Renewal needs an answer.', draftReply }],
      }),
    });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    const stored = deps.briefs.markReady.mock.calls[0][1];
    expect(stored.decisions).toEqual([
      { id: 'd1', text: 'Renewal needs an answer.', source: { kind: 'email', emailId: 'e1' }, draftReply },
    ]);
    expect(deps.push).toHaveBeenCalledWith(expect.objectContaining({ body: '1 decision needs you.' }));
    expect(deps.emails.markBriefed).toHaveBeenCalledWith('u1', ['e1'], new Date('2026-11-17T01:00:00Z'));
    expect(deps.briefs.removeEmailSourcedItems).not.toHaveBeenCalled();
  });

  const fyiActivity = {
    ...activeActivity,
    emails: [
      { emailId: 'e1', kind: 'fyi', summary: 'Office closed Friday.' },
      { emailId: 'e2', kind: 'fyi', summary: 'New parking rules.' },
    ],
  };

  it('pulls the items of an email deleted while the brief composed', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(fyiActivity) });
    deps.emails.storedEmailIds.mockResolvedValue(['e2']);
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.briefs.removeEmailSourcedItems).toHaveBeenCalledWith('u1', ['e1']);
    expect(deps.push).toHaveBeenCalled();
  });

  it('still pushes a stored brief when marking its emails briefed fails', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(fyiActivity) });
    deps.emails.markBriefed.mockRejectedValue(new Error('db down'));
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.push).toHaveBeenCalled();
    expect(deps.briefs.markFailed).not.toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith('[Brief] could not mark the briefed emails', expect.anything());
  });

  it('still drops brief items of a deleted email when marking briefed fails', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(fyiActivity) });
    deps.emails.markBriefed.mockRejectedValue(new Error('db down'));
    deps.emails.storedEmailIds.mockResolvedValue(['e2']);
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.briefs.removeEmailSourcedItems).toHaveBeenCalledWith('u1', ['e1']);
    expect(deps.push).toHaveBeenCalled();
  });

  it('marks no email briefed when the brief does not settle', async () => {
    const deps = makeDeps({
      loadActivity: vi.fn().mockResolvedValue({
        ...activeActivity,
        emails: [{ emailId: 'e1', kind: 'fyi', summary: 'Office closed Friday.' }],
      }),
    });
    deps.briefs.markReady.mockResolvedValue(false);
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.emails.markBriefed).not.toHaveBeenCalled();
  });

  it('settles an empty window without calling the model', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, runs: [], approvals: [] }) });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.briefs.markReady.mock.calls[0][1].headline).toBe('Nothing new since your last brief.');
  });

  it('discards an empty scheduled brief without a model call or a push', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, runs: [], approvals: [] }) });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

    expect(deps.briefs.discardComposing).toHaveBeenCalledWith('b1');
    expect(deps.briefs.markReady).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.push).not.toHaveBeenCalled();
  });

  it('still composes a scheduled brief that has activity', async () => {
    const deps = makeDeps();
    await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

    expect(deps.briefs.discardComposing).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(deps.push).toHaveBeenCalledOnce();
  });

  describe('busy-block brief that does not land', () => {
    const block = { start: new Date('2026-11-17T00:00:00Z'), end: new Date('2026-11-17T00:30:00Z') };
    const blockBrief = () => brief({ trigger: 'busy_block', busyBlock: block });

    it('sends the held-runs summary when the balance gate discards it', async () => {
      const deps = makeDeps({ canCompose: vi.fn().mockResolvedValue('insufficient_credits') });
      deps.briefs.findById = vi.fn().mockResolvedValue(blockBrief());
      await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

      expect(deps.briefs.discardComposing).toHaveBeenCalledWith('b1');
      expect(deps.notifyHeldRuns).toHaveBeenCalledWith('u1', block);
      expect(deps.push).not.toHaveBeenCalled();
    });

    it('sends the held-runs summary when composition fails', async () => {
      const deps = makeDeps({ complete: vi.fn().mockRejectedValue(new Error('model down')) });
      deps.briefs.findById = vi.fn().mockResolvedValue(blockBrief());
      await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

      expect(deps.briefs.markFailed).toHaveBeenCalledWith('b1', 'composition_failed');
      expect(deps.notifyHeldRuns).toHaveBeenCalledWith('u1', block);
    });

    it.each(['gate', 'model'] as const)(
      'preserves held-run delivery when a %s fallback only surfaces reminders',
      async failure => {
        const deps = makeDeps({
          loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, reminders }),
          ...(failure === 'gate'
            ? { canCompose: vi.fn().mockResolvedValue('insufficient_credits') }
            : { complete: vi.fn().mockResolvedValue('not json') }),
        });
        deps.briefs.findById = vi.fn().mockResolvedValue(blockBrief());
        await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });
        expect(deps.briefs.markReady).toHaveBeenCalledWith('b1', expect.any(Object), expect.any(Date), {
          periodEnd: blockBrief().periodStart,
        });
        expect(deps.briefs.markRemindersSurfaced).toHaveBeenCalledWith('u1', reminders, expect.any(Date));
        expect(deps.notifyHeldRuns).toHaveBeenCalledExactlyOnceWith('u1', block);
        expect(deps.briefs.markReady.mock.invocationCallOrder[0]).toBeLessThan(
          deps.notifyHeldRuns.mock.invocationCallOrder[0]
        );
      }
    );

    it('does not release held runs when a reminder fallback loses its ready-state claim', async () => {
      const deps = makeDeps({
        loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, reminders }),
        canCompose: vi.fn().mockResolvedValue('insufficient_credits'),
      });
      deps.briefs.findById = vi.fn().mockResolvedValue(blockBrief());
      deps.briefs.markReady.mockResolvedValue(false);
      await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });
      expect(deps.notifyHeldRuns).not.toHaveBeenCalled();
      expect(deps.briefs.markRemindersSurfaced).not.toHaveBeenCalled();
    });

    it('sends no summary when the block brief is delivered, or for a regular scheduled discard', async () => {
      const delivered = makeDeps();
      delivered.briefs.findById = vi.fn().mockResolvedValue(blockBrief());
      await composeBrief(delivered, { briefId: 'b1', userId: 'u1', scheduled: true });
      expect(delivered.push).toHaveBeenCalledWith(expect.objectContaining({ category: 'brief_ready' }));
      expect(delivered.notifyHeldRuns).not.toHaveBeenCalled();

      const regular = makeDeps({ canCompose: vi.fn().mockResolvedValue('insufficient_credits') });
      await composeBrief(regular, { briefId: 'b1', userId: 'u1', scheduled: true });
      expect(regular.notifyHeldRuns).not.toHaveBeenCalled();
    });
  });

  describe('block-end push categories', () => {
    const block = { start: new Date('2026-11-17T00:00:00Z'), end: new Date('2026-11-17T00:30:00Z') };
    const runsOnly = {
      ...activeActivity,
      approvals: [],
      runs: [
        { id: 'r1', query: 'q', status: 'completed', finishedAt: undefined, errorMessage: undefined },
        { id: 'r2', query: 'q', status: 'failed', finishedAt: undefined, errorMessage: 'boom' },
      ],
    };

    it('tags a busy-block brief push with the categories it reports', async () => {
      const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(runsOnly) });
      deps.briefs.findById = vi.fn().mockResolvedValue(brief({ trigger: 'busy_block', busyBlock: block }));
      await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });
      expect(deps.briefs.markReady).toHaveBeenCalledOnce();
      expect(deps.push).toHaveBeenCalledWith(
        expect.objectContaining({ category: 'brief_ready', blockEndCategories: ['agent_completed', 'agent_failed'] })
      );
    });

    it('leaves a regular brief push untagged', async () => {
      const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(runsOnly) });
      await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });
      expect(deps.push).toHaveBeenCalledOnce();
      expect(deps.push.mock.calls[0][0]).not.toHaveProperty('blockEndCategories');
    });
  });

  it('composes a scheduled brief whose only activity is an obligation coming due', async () => {
    const obligation = {
      obligationId: 'o1',
      payee: 'Example Utilities',
      amount: 120.5,
      currency: 'USD',
      dueDate: '2026-11-20',
      summary: 'Power bill',
    };
    const deps = makeDeps({
      loadActivity: vi
        .fn()
        .mockResolvedValue({ ...activeActivity, runs: [], approvals: [], obligations: [obligation] }),
      complete: vi.fn().mockResolvedValue(JSON.stringify({ headline: 'A bill is due.' })),
    });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

    expect(deps.briefs.discardComposing).not.toHaveBeenCalled();
    expect(deps.complete).toHaveBeenCalledOnce();
    expect(deps.briefs.markReady.mock.calls[0][1].happened).toMatchObject([
      { source: { kind: 'obligation', obligationId: 'o1' } },
    ]);
    expect(deps.push).toHaveBeenCalledOnce();
  });

  it('fails the brief, and sends no push, when the balance gate refuses', async () => {
    const deps = makeDeps({ canCompose: vi.fn().mockResolvedValue('insufficient_credits') });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    expect(deps.briefs.markFailed).toHaveBeenCalledWith('b1', 'insufficient_credits');
    expect(deps.push).not.toHaveBeenCalled();
  });

  it.each(['insufficient_credits', 'ai_access_held'] as const)(
    'discards a scheduled brief, leaving no failed row, when the gate answers %s',
    async gate => {
      const deps = makeDeps({ canCompose: vi.fn().mockResolvedValue(gate) });
      await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

      expect(deps.briefs.discardComposing).toHaveBeenCalledWith('b1');
      expect(deps.briefs.markFailed).not.toHaveBeenCalled();
      expect(deps.complete).not.toHaveBeenCalled();
      expect(deps.push).not.toHaveBeenCalled();
    }
  );

  it('surfaces due reminders of a gated scheduled brief without a model call, keeping the activity window open', async () => {
    const reminders = [{ briefId: 'b0', decisionId: 'fu-reminder-1', text: 'Remind me: call the vendor' }];
    const deps = makeDeps({
      canCompose: vi.fn().mockResolvedValue('insufficient_credits'),
      loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, reminders }),
    });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

    expect(deps.complete).not.toHaveBeenCalled();
    expect(deps.briefs.discardComposing).not.toHaveBeenCalled();
    const [, composed, , options] = deps.briefs.markReady.mock.calls[0];
    expect(composed.happened.map((item: { text: string }) => item.text)).toEqual(['Reminder: call the vendor']);
    expect(options).toEqual({ periodEnd: new Date('2026-11-16T00:00:00Z') });
    expect(deps.briefs.markRemindersSurfaced).toHaveBeenCalledOnce();
  });

  it('surfaces due reminders of a scheduled brief whose model reply is malformed, keeping the activity window open', async () => {
    const reminders = [{ briefId: 'b0', decisionId: 'fu-reminder-1', text: 'Remind me: call the vendor' }];
    const deps = makeDeps({
      complete: vi.fn().mockResolvedValue('not json'),
      loadActivity: vi.fn().mockResolvedValue({ ...activeActivity, reminders }),
    });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1', scheduled: true });

    expect(deps.briefs.markFailed).not.toHaveBeenCalled();
    const [, composed, , options] = deps.briefs.markReady.mock.calls[0];
    expect(composed.happened.map((item: { text: string }) => item.text)).toEqual(['Reminder: call the vendor']);
    expect(options).toEqual({ periodEnd: new Date('2026-11-16T00:00:00Z') });
    expect(deps.briefs.markRemindersSurfaced).toHaveBeenCalledOnce();
  });

  it('fails the brief on a malformed model reply', async () => {
    const deps = makeDeps({ complete: vi.fn().mockResolvedValue('not json') });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    expect(deps.briefs.markFailed).toHaveBeenCalledWith('b1', 'composition_failed');
    expect(deps.push).not.toHaveBeenCalled();
  });

  it('skips a brief owned by someone else or already settled', async () => {
    const other = makeDeps();
    other.briefs.findById = vi.fn().mockResolvedValue(brief({ userId: 'someone-else' }));
    await composeBrief(other, { briefId: 'b1', userId: 'u1' });
    expect(other.complete).not.toHaveBeenCalled();

    const settled = makeDeps();
    settled.briefs.findById = vi.fn().mockResolvedValue(brief({ status: 'ready' }));
    await composeBrief(settled, { briefId: 'b1', userId: 'u1' });
    expect(settled.briefs.markReady).not.toHaveBeenCalled();
  });

  const delegationActivity = {
    ...activeActivity,
    runs: [],
    approvals: [],
    delegations: [
      { delegationId: 'g1', intent: 'Summarize', status: 'handled', result: 'Summary.' },
      { delegationId: 'g2', intent: 'Read later', status: 'pending', result: null },
    ],
  };

  it('marks the settled delegated items briefed and leaves pending ones for a later brief', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(delegationActivity) });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    const stored = deps.briefs.markReady.mock.calls[0][1];
    expect(stored.handled[0]).toMatchObject({ text: 'Summary.', source: { kind: 'delegation', delegationId: 'g1' } });
    expect(stored.happened[0]).toMatchObject({ source: { kind: 'delegation', delegationId: 'g2' } });
    expect(deps.delegations.markBriefed).toHaveBeenCalledWith('u1', ['g1'], new Date('2026-11-17T01:00:00Z'));
  });

  it('leaves delegated items unbriefed when the brief fails', async () => {
    const deps = makeDeps({
      loadActivity: vi.fn().mockResolvedValue(delegationActivity),
      complete: vi.fn().mockResolvedValue('not json'),
    });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.briefs.markFailed).toHaveBeenCalledWith('b1', 'composition_failed');
    expect(deps.delegations.markBriefed).not.toHaveBeenCalled();
  });

  it('still pushes a stored brief when marking its delegated items fails', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(delegationActivity) });
    deps.delegations.markBriefed.mockRejectedValue(new Error('db down'));
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.push).toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith('[Brief] could not mark the briefed delegations', expect.anything());
  });

  it('fails the brief when its user is gone', async () => {
    const deps = makeDeps({ users: { findById: vi.fn().mockResolvedValue(null) } });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.briefs.markFailed).toHaveBeenCalledWith('b1', 'user_missing');
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('still pushes when checking for deleted emails fails', async () => {
    const deps = makeDeps({ loadActivity: vi.fn().mockResolvedValue(fyiActivity) });
    deps.emails.storedEmailIds.mockRejectedValue(new Error('db down'));
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });
    expect(deps.push).toHaveBeenCalled();
    expect(deps.logger.error).toHaveBeenCalledWith(
      '[Brief] could not drop brief items of deleted emails',
      expect.anything()
    );
  });
});
