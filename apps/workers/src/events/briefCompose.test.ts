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
  emails: [],
};

function makeDeps(overrides: Partial<BriefComposeDeps> = {}) {
  const deps = {
    now: () => new Date('2026-11-17T01:00:00Z'),
    users: { findById: vi.fn().mockResolvedValue({ id: 'u1' }) },
    briefs: {
      findById: vi.fn().mockResolvedValue(brief()),
      markReady: vi.fn().mockResolvedValue(true),
      markFailed: vi.fn().mockResolvedValue(true),
      removeEmailSourcedItems: vi.fn().mockResolvedValue(0),
    },
    loadActivity: vi.fn().mockResolvedValue(activeActivity),
    canCompose: vi.fn().mockResolvedValue('ok'),
    complete: vi.fn().mockResolvedValue(JSON.stringify({ headline: 'Done.', handled: ['Did a thing.'] })),
    push: vi.fn().mockResolvedValue(undefined),
    emails: {
      markBriefed: vi.fn().mockResolvedValue(0),
      storedEmailIds: vi.fn((_userId: string, ids: string[]) => Promise.resolve(ids)),
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    ...overrides,
  } as unknown as BriefComposeDeps & {
    briefs: {
      markReady: ReturnType<typeof vi.fn>;
      markFailed: ReturnType<typeof vi.fn>;
      removeEmailSourcedItems: ReturnType<typeof vi.fn>;
    };
    push: ReturnType<typeof vi.fn>;
    complete: ReturnType<typeof vi.fn>;
    emails: { markBriefed: ReturnType<typeof vi.fn>; storedEmailIds: ReturnType<typeof vi.fn> };
    logger: { error: ReturnType<typeof vi.fn> };
  };
  return deps;
}

describe('composeBrief', () => {
  it('composes, stores and pushes brief_ready with the brief id', async () => {
    const deps = makeDeps();
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    expect(deps.briefs.markReady).toHaveBeenCalledOnce();
    const stored = deps.briefs.markReady.mock.calls[0][1];
    expect(stored.decisions[0].approval).toEqual({ questId: 'q1', sessionId: 's1', pendingActionTs: 5 });
    expect(deps.push).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', category: 'brief_ready', briefId: 'b1', body: '1 decision needs you.' })
    );
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

  it('fails the brief, and sends no push, when the balance gate refuses', async () => {
    const deps = makeDeps({ canCompose: vi.fn().mockResolvedValue('insufficient_credits') });
    await composeBrief(deps, { briefId: 'b1', userId: 'u1' });

    expect(deps.briefs.markFailed).toHaveBeenCalledWith('b1', 'insufficient_credits');
    expect(deps.push).not.toHaveBeenCalled();
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
});
