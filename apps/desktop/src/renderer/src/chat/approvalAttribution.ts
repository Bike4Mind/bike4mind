import type { ChatApprovalSystemReason, ChatToolApproval } from '@shared/chat';
import { APPROVAL_MODE_OPTIONS } from './approvalModes';

const CLOSED_REASON: Record<Exclude<ChatApprovalSystemReason, 'error'>, string> = {
  stopped: 'Not run - reply stopped before approval',
  'conversation-deleted': 'Not run - conversation deleted before approval',
  'app-quit': 'Not run - app quit before approval',
  'moved-on': 'Not run - closed when a new message was sent',
};

/**
 * The one line under a settled call saying who let it run or stopped it. A system close is
 * worded as "not run" rather than as a refusal, because nobody refused it.
 */
export function describeApproval(approval: ChatToolApproval): string {
  const { decidedBy, outcome } = approval;
  switch (decidedBy.kind) {
    case 'user': {
      const option = decidedBy.option ? ` - ${decidedBy.option}` : '';
      if (decidedBy.answer === 'deny') return 'Declined by you';
      if (decidedBy.answer === 'redirect') return `Redirected by you${option}`;
      if (decidedBy.answer === 'always') {
        return `Approved by you - always${decidedBy.everywhere ? ', in every session' : ' in this chat'}${option}`;
      }
      return `Approved by you${option}`;
    }
    case 'rule':
      return `${outcome === 'allowed' ? 'Allowed' : 'Denied'} by rule ${decidedBy.rule}`;
    case 'chat-allowance':
      return outcome === 'allowed' ? 'Allowed in this chat' : 'Denied in this chat';
    case 'mode': {
      const label = APPROVAL_MODE_OPTIONS.find(option => option.mode === decidedBy.mode)?.label ?? decidedBy.mode;
      return `Auto-approved - ${label}`;
    }
    case 'system':
      return decidedBy.reason === 'error'
        ? `Blocked${decidedBy.detail ? ` - ${decidedBy.detail}` : ''}`
        : CLOSED_REASON[decidedBy.reason];
  }
}
