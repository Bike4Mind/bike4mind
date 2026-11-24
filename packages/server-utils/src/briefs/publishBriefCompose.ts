import { BriefEvents } from '../utils/eventBus';

export class BriefComposeRejectedError extends Error {
  constructor() {
    super('Brief composition event was not accepted');
    this.name = 'BriefComposeRejectedError';
  }
}

export async function publishBriefCompose(event: Parameters<typeof BriefEvents.Compose.publish>[0]): Promise<void> {
  if (process.env.B4M_SELF_HOST === 'true' && !process.env.SELF_HOST_EVENT_QUEUE) {
    throw new BriefComposeRejectedError();
  }
  // A transport exception cannot establish whether the remote service accepted the event.
  const result = await BriefEvents.Compose.publish(event, { requireAcceptance: true });
  if (result && ((result.FailedEntryCount ?? 0) > 0 || result.Entries?.some(entry => entry.ErrorCode))) {
    throw new BriefComposeRejectedError();
  }
}
