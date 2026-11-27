import { describe, expect, it } from 'vitest';
import type { ChatSessionStatusEvent } from '@shared/chat';
import { SessionActivity, endsUnread } from './SessionActivity';

function track(): { activity: SessionActivity; events: ChatSessionStatusEvent[] } {
  const events: ChatSessionStatusEvent[] = [];
  return { activity: new SessionActivity(event => events.push(event)), events };
}

describe('SessionActivity background jobs', () => {
  function trackChanges(): {
    activity: SessionActivity;
    events: { event: ChatSessionStatusEvent; statusChanged: boolean }[];
  } {
    const events: { event: ChatSessionStatusEvent; statusChanged: boolean }[] = [];
    return { activity: new SessionActivity((event, statusChanged) => events.push({ event, statusChanged })), events };
  }

  it('carries running jobs on a done session without calling it a status change', () => {
    const { activity, events } = trackChanges();
    activity.backgroundChanged('a', { running: 1, label: 'pnpm test' });

    expect(activity.statusOf('a')).toBe('done');
    expect(events).toEqual([
      {
        event: { sessionId: 'a', status: 'done', background: { running: 1, label: 'pnpm test' } },
        statusChanged: false,
      },
    ]);
    expect(activity.snapshot()).toEqual([
      { sessionId: 'a', status: 'done', background: { running: 1, label: 'pnpm test' } },
    ]);
  });

  it('keeps the jobs on the done event of a turn that ends while they run', () => {
    const { activity, events } = trackChanges();
    activity.replyStarted('a');
    activity.backgroundChanged('a', { running: 2, label: 'pnpm build' });
    activity.replyEnded('a');

    expect(events.at(-1)).toEqual({
      event: { sessionId: 'a', status: 'done', background: { running: 2, label: 'pnpm build' }, settledTurns: 1 },
      statusChanged: true,
    });
  });

  it('sends nothing for the same jobs again, and clears them when the last one ends', () => {
    const { activity, events } = trackChanges();
    activity.backgroundChanged('a', { running: 1, label: 'pnpm test' });
    activity.backgroundChanged('a', { running: 1, label: 'pnpm test' });
    expect(events).toHaveLength(1);

    activity.backgroundChanged('a', undefined);
    expect(events.at(-1)).toEqual({ event: { sessionId: 'a', status: 'done' }, statusChanged: false });
    expect(activity.snapshot()).toEqual([]);
  });

  it('treats a zero count as none', () => {
    const { activity, events } = trackChanges();
    activity.backgroundChanged('a', { running: 0, label: 'x' });
    expect(events).toEqual([]);
  });

  it('forgets the jobs of a deleted conversation silently', () => {
    const { activity, events } = trackChanges();
    activity.backgroundChanged('a', { running: 1, label: 'pnpm test' });
    activity.forget('a');
    expect(events).toHaveLength(1);
    expect(activity.snapshot()).toEqual([]);
  });
});

describe('SessionActivity', () => {
  it('badges an unread finished reply until viewed without keeping its turn open', () => {
    const { activity } = track();
    activity.replyStarted('a');
    activity.replyEnded('a', true);
    expect(activity.statusOf('a')).toBe('needs-action');
    expect(activity.runtimeStatusOf('a')).toBe('done');
    expect(activity.snapshot()).toEqual([
      { sessionId: 'a', status: 'needs-action', unreadReply: true, settledTurns: 1 },
    ]);
    activity.viewed('a');
    expect(activity.statusOf('a')).toBe('done');
    expect(activity.snapshot()).toEqual([]);
  });

  it('does not clear approvals, held messages or decisions when a reply is viewed', () => {
    const { activity, events } = track();
    activity.replyStarted('a');
    activity.replyEnded('a', true);
    activity.approvalRequested('a');
    expect(events.at(-1)).toEqual({ sessionId: 'a', status: 'needs-action', settledTurns: 1 });
    activity.heldChanged('a', true);
    activity.decisionChanged('a', true);
    activity.viewed('a');
    activity.approvalSettled('a');
    activity.heldChanged('a', false);
    expect(activity.statusOf('a')).toBe('needs-action');
    activity.decisionChanged('a', false);
    expect(activity.statusOf('a')).toBe('done');
  });

  it('replaces unread attention with working and forgets unread deleted sessions', () => {
    const { activity } = track();
    activity.replyEnded('a', true);
    activity.replyStarted('a');
    expect(activity.statusOf('a')).toBe('processing');
    activity.replyEnded('a');
    expect(activity.statusOf('a')).toBe('done');
    activity.replyEnded('a', true);
    activity.forget('a');
    expect(activity.snapshot()).toEqual([]);
  });

  it('reports an untouched session as done', () => {
    const { activity, events } = track();
    expect(activity.statusOf('a')).toBe('done');
    expect(activity.snapshot()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('moves through processing and back to done across one reply', () => {
    const { activity, events } = track();

    activity.replyStarted('a');
    expect(activity.statusOf('a')).toBe('processing');

    activity.replyEnded('a');
    expect(activity.statusOf('a')).toBe('done');
    expect(events).toEqual([
      { sessionId: 'a', status: 'processing' },
      { sessionId: 'a', status: 'done', settledTurns: 1 },
    ]);
  });

  it('counts each settled turn on the status, one per turn of a queued chain', () => {
    const { activity, events } = track();

    activity.replyStarted('a');
    activity.replyEnded('a');
    activity.replyStarted('a');
    activity.replyEnded('a');

    expect(events.map(event => event.settledTurns)).toEqual([undefined, 1, 1, 2]);
    expect(activity.snapshot()).toEqual([]);
  });

  it('starts a deleted session counter again from zero', () => {
    const { activity, events } = track();
    activity.replyStarted('a');
    activity.replyEnded('a');
    activity.forget('a');
    activity.replyStarted('a');
    activity.replyEnded('a');

    expect(events.at(-1)).toEqual({ sessionId: 'a', status: 'done', settledTurns: 1 });
  });

  // The state the sidebar exists for: the turn is still open, so the session is also
  // 'replying', but the user is the one holding it up.
  it('outranks processing with needs-action while a tool waits at the gate', () => {
    const { activity, events } = track();

    activity.replyStarted('a');
    activity.approvalRequested('a');
    expect(activity.statusOf('a')).toBe('needs-action');

    activity.approvalSettled('a');
    expect(activity.statusOf('a')).toBe('processing');

    expect(events.map(event => event.status)).toEqual(['processing', 'needs-action', 'processing']);
  });

  it('stays in needs-action until the last of several approvals is answered', () => {
    const { activity, events } = track();
    activity.replyStarted('a');
    activity.approvalRequested('a');
    activity.approvalRequested('a');
    activity.approvalRequested('a');

    activity.approvalSettled('a');
    activity.approvalSettled('a');
    expect(activity.statusOf('a')).toBe('needs-action');

    activity.approvalSettled('a');
    expect(activity.statusOf('a')).toBe('processing');

    // Three asks and three answers, but only the two real transitions were announced.
    expect(events.map(event => event.status)).toEqual(['processing', 'needs-action', 'processing']);
  });

  it('keeps needs-action when the reply ends before the approval is answered', () => {
    const { activity } = track();
    activity.replyStarted('a');
    activity.approvalRequested('a');
    activity.replyEnded('a');

    expect(activity.statusOf('a')).toBe('needs-action');
  });

  it('stays processing from a worktree being prepared into the reply it starts, with no done between', () => {
    const { activity, events } = track();

    activity.preparingStarted('a', 'worktree');
    expect(activity.statusOf('a')).toBe('processing');
    expect(activity.snapshot()).toEqual([{ sessionId: 'a', status: 'processing', preparing: 'worktree' }]);
    activity.replyStarted('a');
    activity.preparingEnded('a');
    expect(activity.statusOf('a')).toBe('processing');
    activity.replyEnded('a');

    // The middle push only drops the preparing flag; the status never leaves 'processing'.
    expect(events.map(event => event.status)).toEqual(['processing', 'processing', 'done']);
  });

  it('tracks sessions independently', () => {
    const { activity } = track();
    activity.replyStarted('a');
    activity.approvalRequested('b');

    expect(activity.statusOf('a')).toBe('processing');
    expect(activity.statusOf('b')).toBe('needs-action');
    expect(activity.statusOf('c')).toBe('done');
  });

  it('snapshots only the sessions that are busy', () => {
    const { activity } = track();
    activity.replyStarted('a');
    activity.approvalRequested('b');
    activity.replyStarted('c');
    activity.replyEnded('c');

    expect(activity.snapshot().sort((left, right) => left.sessionId.localeCompare(right.sessionId))).toEqual([
      { sessionId: 'a', status: 'processing' },
      { sessionId: 'b', status: 'needs-action' },
    ]);
  });

  it('does not drop below zero when an approval settles twice', () => {
    const { activity, events } = track();
    activity.approvalRequested('a');
    activity.approvalSettled('a');
    activity.approvalSettled('a');

    expect(activity.statusOf('a')).toBe('done');
    activity.approvalRequested('a');
    expect(activity.statusOf('a')).toBe('needs-action');
    expect(events.map(event => event.status)).toEqual(['needs-action', 'done', 'needs-action']);
  });

  it('forgets a deleted session without announcing it', () => {
    const { activity, events } = track();
    activity.replyStarted('a');
    events.length = 0;

    activity.forget('a');
    expect(activity.statusOf('a')).toBe('done');
    expect(activity.snapshot()).toEqual([]);
    expect(events).toEqual([]);
  });

  it('flags preparing until a reply starts, and pushes the flag flipping off', () => {
    const { activity, events } = track();

    activity.preparingStarted('a', 'worktree');
    expect(activity.snapshot()).toEqual([{ sessionId: 'a', status: 'processing', preparing: 'worktree' }]);

    activity.replyStarted('a');
    activity.preparingEnded('a');
    activity.replyEnded('a');

    expect(events).toEqual([
      { sessionId: 'a', status: 'processing', preparing: 'worktree' },
      { sessionId: 'a', status: 'processing' },
      { sessionId: 'a', status: 'done', settledTurns: 1 },
    ]);
  });

  it('pushes each setup step, ignoring a repeat and a session that is not preparing', () => {
    const { activity, events } = track();

    activity.preparingStep('b', 'starting');
    activity.preparingStarted('a', 'worktree');
    activity.preparingStep('a', 'worktree');
    activity.preparingStep('a', 'starting');
    activity.preparingStep('a', 'starting');

    expect(events).toEqual([
      { sessionId: 'a', status: 'processing', preparing: 'worktree' },
      { sessionId: 'a', status: 'processing', preparing: 'starting' },
    ]);
    expect(activity.statusOf('b')).toBe('done');
  });

  it('does not flag preparing while a session waits on approval', () => {
    const { activity, events } = track();

    activity.preparingStarted('a', 'worktree');
    activity.approvalRequested('a');

    expect(events.at(-1)).toEqual({ sessionId: 'a', status: 'needs-action' });
    expect(activity.snapshot()).toEqual([{ sessionId: 'a', status: 'needs-action' }]);
  });

  it('shows a session with a held relay as needs-action until it is cleared', () => {
    const { activity, events } = track();

    activity.heldChanged('a', true);
    expect(activity.statusOf('a')).toBe('needs-action');
    expect(activity.snapshot()).toEqual([{ sessionId: 'a', status: 'needs-action' }]);

    activity.heldChanged('a', false);
    expect(activity.statusOf('a')).toBe('done');
    expect(activity.snapshot()).toEqual([]);
    expect(events.map(event => event.status)).toEqual(['needs-action', 'done']);
  });

  it('shows a worker waiting on a user decision as needs-action until it is answered or forgotten', () => {
    const { activity, events } = track();

    activity.decisionChanged('a', true);
    expect(activity.statusOf('a')).toBe('needs-action');
    expect(activity.snapshot()).toEqual([{ sessionId: 'a', status: 'needs-action' }]);

    activity.decisionChanged('a', false);
    expect(activity.statusOf('a')).toBe('done');
    activity.decisionChanged('b', true);
    activity.forget('b');
    expect(activity.snapshot()).toEqual([]);
    expect(events.map(event => event.status)).toEqual(['needs-action', 'done', 'needs-action']);
  });
});

describe('endsUnread', () => {
  it('leaves a finished answer with text, or a failed turn, unread', () => {
    expect(endsUnread('completed', 'Here it is')).toBe(true);
    expect(endsUnread('failed', '')).toBe(true);
  });

  it('leaves nothing for an empty answer, a stop, or an expired session', () => {
    expect(endsUnread('completed', '  ')).toBe(false);
    expect(endsUnread('aborted', 'partial')).toBe(false);
    expect(endsUnread('expired', '')).toBe(false);
  });
});
