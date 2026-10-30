import type { ILoopDirective } from '@bike4mind/common';

/** A directive as a log row; owner replies drop their `userId`. Shared by the events and override routes. */
export const directiveRow = (directive: ILoopDirective) => ({
  id: directive.id,
  kind: 'directive' as const,
  loopId: directive.loopId,
  fromLoopId: directive.fromLoopId,
  fromLoopName: directive.fromLoopName,
  executionId: directive.executionId,
  instruction: directive.instruction,
  reason: directive.reason,
  state: directive.state,
  replies: directive.replies.map(reply => (reply.by === 'owner' ? { ...reply, userId: undefined } : reply)),
  createdAt: directive.createdAt,
});
