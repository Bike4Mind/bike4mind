import { useEffect, useMemo, useState } from 'react';
import type { ChatMessage } from '@shared/chat';
import { pendingCallsIn } from '@shared/needsYou';
import type { ViewApproval } from '@shared/viewSnapshot';
import { approvalSummary, isQuickApproval } from '@shared/watch';
import { hostChat } from '../../host/hostChat';
import { activityLabel } from './activity';
import { refreshKeyOf } from './AgentPeekDrawer';
import type { AgentView, ParentView } from './roster';

/** One session's calls at the approval gate that the menu bar and the mini window could answer too. */
export function quickApprovalsIn(sessionId: string, messages: readonly ChatMessage[]): ViewApproval[] {
  return pendingCallsIn(messages).flatMap(call =>
    call.approvalId && isQuickApproval(call) ? [{ id: call.approvalId, sessionId, label: approvalSummary(call) }] : []
  );
}

interface WaitingSession {
  sessionId: string;
  /** Changes whenever the session may have parked or settled a call. */
  refreshKey: string;
}

function waitingSessions(
  rootId: string | undefined,
  agents: readonly AgentView[],
  parent: ParentView
): WaitingSession[] {
  const waiting = agents
    .filter(agent => agent.state === 'needs-you')
    .map(agent => ({ sessionId: agent.id, refreshKey: refreshKeyOf(agent) }));
  if (rootId === undefined || parent.status !== 'needs-action') return waiting;
  const rootKey = parent.activity ? activityLabel(parent.activity) : '';
  return [{ sessionId: rootId, refreshKey: rootKey }, ...waiting];
}

/**
 * The quick approvals of the root and its waiting agents, read from each one's messages as the peek
 * drawer reads them, while `enabled`. A session whose read fails lists none: its item still opens.
 */
export function useQuickApprovals(
  enabled: boolean,
  rootId: string | undefined,
  agents: readonly AgentView[],
  parent: ParentView
): ViewApproval[] {
  const sessions = useMemo(
    () => (enabled ? waitingSessions(rootId, agents, parent) : []),
    [enabled, rootId, agents, parent]
  );
  const key = sessions.map(session => `${session.sessionId}\n${session.refreshKey}`).join('\n\n');
  const [approvals, setApprovals] = useState<ViewApproval[]>([]);

  useEffect(() => {
    let stale = false;
    const reads = sessions.map(({ sessionId }) =>
      hostChat.getSession(sessionId).then(
        session => quickApprovalsIn(sessionId, session?.messages ?? []),
        (): ViewApproval[] => []
      )
    );
    void Promise.all(reads).then(lists => {
      if (!stale) setApprovals(lists.flat());
    });
    return () => {
      stale = true;
    };
    // Keyed on `key`, what `sessions` holds: a fresh array with the same sessions and keys reads nothing new.
  }, [key]);

  return approvals;
}
