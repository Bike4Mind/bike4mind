import { CssVarsProvider } from '@mui/joy/styles';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MISSING_TASK_RESULT_REASON } from '@shared/agentState';
import type { ChatSessionStatus, ChatSessionSummary } from '@shared/chat';
import { pendingDecisionOf, type WorkerTask } from '@shared/orchestration';
import { SessionActivity } from '../../../../main/chat/SessionActivity';
import { SessionBadge } from '../SessionBadge';
import { agentStates, buildRoster } from './roster';

const decision = {
  id: 'decision',
  askedAt: '2026-11-19',
  question: { header: 'Branch', question: 'Which branch?', options: [{ label: 'main', description: '' }] },
};
const states = [
  { status: 'completed', accepted: false },
  { status: 'completed', accepted: true },
  { status: 'blocked', reason: MISSING_TASK_RESULT_REASON, evidence: [] },
  { status: 'blocked', reason: 'Missing access', evidence: [], decision },
  { status: 'escalated' },
  { status: 'paused' },
] as WorkerTask['state'][];

describe.each(states)('scene/sidebar parity for $status', state => {
  it.each([true, false, undefined])('uses the notification badge when attentionViewed=%s', attentionViewed => {
    const workerTask = { state, attentionViewed, resolvedDecisions: [] } as unknown as WorkerTask;
    const child = {
      id: 'child',
      title: 'Agent',
      origin: { parentSessionId: 'root' },
      createdAt: '',
      updatedAt: '',
      lastOutcome: 'finished',
      workerTask,
    } as ChatSessionSummary;
    const sessions = [{ id: 'root' } as ChatSessionSummary, child];
    const activity = new SessionActivity(() => {});
    const pending = pendingDecisionOf(workerTask);
    activity.decisionChanged(child.id, pending !== undefined);

    const check = (expected: 'done' | 'working' | 'needs-you') => {
      const status = activity.statusOf(child.id);
      const statuses = new Map<string, ChatSessionStatus>(status === 'done' ? [] : [[child.id, status]]);
      const roster = buildRoster({ sessions, statuses, activity: new Map(), prSummaries: new Map(), rootId: 'root' });
      expect(roster[0].state).toBe(expected);
      expect(agentStates(sessions, statuses, 'root')).toEqual([expected]);
      expect(roster[0].decision).toEqual(pending);
      for (const pr of [undefined, { number: 42, state: 'merged' as const }]) {
        const html = renderToStaticMarkup(
          <CssVarsProvider>
            <SessionBadge status={statuses.get(child.id) ?? 'done'} pr={pr} deciding={pending !== undefined} />
          </CssVarsProvider>
        );
        expect(html.includes('data-status="needs-action"')).toBe(roster[0].state === 'needs-you');
        if (expected === 'needs-you') {
          expect(html).toContain(pending ? 'Needs your decision' : 'Needs you');
          expect(html).not.toContain('PR #42');
        }
      }
    };

    check(pending ? 'needs-you' : 'done');
    activity.replyStarted(child.id);
    check(pending ? 'needs-you' : 'working');
    activity.approvalRequested(child.id);
    check('needs-you');
    activity.approvalSettled(child.id);
    activity.replyEnded(child.id);
    check(pending ? 'needs-you' : 'done');
  });
});
