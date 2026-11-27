import { runAfterCommit, withTransaction } from '@bike4mind/database';
import { EmailEvents, type EmailSendDetail } from '@bike4mind/server-utils/utils/eventBus';

type QueueEmail = (detail: EmailSendDetail) => void;

/**
 * Runs `fn` in withTransaction and publishes the email it queues only after the commit, so a retried
 * callback sends once and an aborted one sends nothing. A failed publish is rethrown after the commit,
 * since runAfterCommit itself only logs after-commit failures.
 */
export async function withTransactionThenEmail<T>(
  fn: (queueEmail: QueueEmail, session: Parameters<typeof runAfterCommit>[0]) => Promise<T>
): Promise<T> {
  let publishFailure: { error: unknown } | undefined;
  const result = await withTransaction(async session => {
    publishFailure = undefined;
    return fn(detail => {
      const queued = runAfterCommit(session, 'email', async () => {
        try {
          await EmailEvents.Send.publish(detail);
        } catch (error) {
          publishFailure = { error };
        }
      });
      if (!queued) throw new Error('withTransactionThenEmail: the session is not owned by withTransaction');
    }, session);
  });
  if (publishFailure) throw publishFailure.error;
  return result;
}
