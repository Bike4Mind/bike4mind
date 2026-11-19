import type { IWorkItem, LoopUnsureFields } from '@bike4mind/common';
import type { IPendingGate } from '@bike4mind/database';

/**
 * The `unsure` loop event for a gate. Written by the loop scheduler (on detach) and by `gate_response`
 * (on resolve); both upsert on `executionId` + `requestedAt`, so whichever lands first creates it.
 */
export const unsureEventFields = (
  run: { loopId: string; userId: string; executionId: string },
  gate: IPendingGate,
  ticket: Pick<IWorkItem, 'id' | 'title'> | null
): LoopUnsureFields => ({
  ...run,
  iteration: gate.iteration,
  confidence: gate.confidence,
  reason: gate.reason,
  requestedAt: gate.requestedAt,
  ...(ticket && { workItemId: ticket.id, ticketTitle: ticket.title }),
});
