import type { ChatApprovalSystemReason, ChatToolApproval } from '@shared/chat';

const CLOSED_REASON: Record<Exclude<ChatApprovalSystemReason, 'error'>, string> = {
  stopped: 'Not run - reply stopped before approval',
  'conversation-deleted': 'Not run - conversation deleted before approval',
  'app-quit': 'Not run - app quit before approval',
  'moved-on': 'Not run - closed when a new message was sent',
};

/**
 * The one line under a settled call that did not run as asked, or null for one that did: who or
 * what let a call through is routine and would sit under nearly every call. A system close is
 * worded as "not run" rather than as a refusal, because nobody refused it.
 */
export function describeApproval(approval: ChatToolApproval): string | null {
  const { decidedBy, outcome } = approval;
  if (outcome === 'allowed') return null;
  switch (decidedBy.kind) {
    case 'user':
      return decidedBy.answer === 'redirect'
        ? `Redirected by you${decidedBy.option ? ` - ${decidedBy.option}` : ''}`
        : 'Declined by you';
    case 'rule':
      return `Denied by rule ${decidedBy.rule}`;
    case 'chat-allowance':
      return 'Denied in this chat';
    case 'mode':
      // A mode decision is only ever recorded as allowed today.
      return 'Denied by the approval mode';
    case 'system':
      return decidedBy.reason === 'error'
        ? `Blocked${decidedBy.detail ? ` - ${decidedBy.detail}` : ''}`
        : CLOSED_REASON[decidedBy.reason];
  }
}
