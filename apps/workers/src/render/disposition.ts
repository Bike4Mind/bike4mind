import { RUNNING_STATUS_FRESH_MS, type RunRenderOutcome } from './runRender';

/** What happened to one received render queue message, including the cases where runRender never ran or threw. */
export type RenderMessageResult =
  | RunRenderOutcome
  | { outcome: 'malformed' }
  /** SIGTERM arrived while the message was being received, so the task never started on it. */
  | { outcome: 'shutting_down' }
  /** runRender threw: reporting itself failed (status write, Mongo). */
  | { outcome: 'errored' };

export type RenderMessageDisposition =
  | { action: 'delete' }
  | { action: 'change_visibility'; seconds: number }
  /** Leave the message alone: it is redelivered when its visibility timeout ends, and the queue's DLQ caps retries. */
  | { action: 'leave' };

// Each redelivery counts toward the queue's DLQ receive limit (3), so two retries must outlast the engine's submit commit.
export const SUBMIT_IN_FLIGHT_RETRY_SECONDS = 20;

// Used when the release write failed: the redelivery must land after the last heartbeat has gone stale.
const UNRELEASED_RETRY_SECONDS = Math.ceil(RUNNING_STATUS_FRESH_MS / 1000) + 5;

export const renderMessageDisposition = (result: RenderMessageResult): RenderMessageDisposition => {
  switch (result.outcome) {
    case 'malformed':
    case 'skipped':
    case 'cancelled':
    case 'already_succeeded':
    case 'succeeded':
    case 'failed':
      return { action: 'delete' };
    case 'not_yet_running':
      return { action: 'change_visibility', seconds: SUBMIT_IN_FLIGHT_RETRY_SECONDS };
    case 'aborted':
      if (!result.released) return { action: 'change_visibility', seconds: UNRELEASED_RETRY_SECONDS };
      return { action: 'change_visibility', seconds: 0 };
    case 'shutting_down':
      // Hand the job straight to another task instead of waiting out the visibility timeout.
      return { action: 'change_visibility', seconds: 0 };
    case 'errored':
      return { action: 'leave' };
    default: {
      const unhandled: never = result;
      throw new Error(`Unhandled render message result: ${JSON.stringify(unhandled)}`);
    }
  }
};
