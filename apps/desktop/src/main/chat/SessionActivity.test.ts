import { describe, expect, it } from 'vitest';
import type { ChatSessionStatusEvent } from '@shared/chat';
import { SessionActivity } from './SessionActivity';

function track(): { activity: SessionActivity; events: ChatSessionStatusEvent[] } {
  const events: ChatSessionStatusEvent[] = [];
  return { activity: new SessionActivity(event => events.push(event)), events };
}

describe('SessionActivity', () => {
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
      { sessionId: 'a', status: 'done' },
    ]);
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
});
