import { dispatchWithLogger } from '@server/queueHandlers/utils';
import { revokeGitHubLakeConnection } from '@server/integrations/github/dataLake/githubLakeConnection';
import { ConflictError } from '@server/utils/errors';
import { z, ZodError } from 'zod';

const Payload = z.object({ connectionId: z.string() });

/**
 * Purges what one GitHub lake connection ingested once the data-lake App loses access to it
 * (github-lake-app.ts: installation deleted, or the repository dropped from the installation's
 * selection). One message per connection. A live sync's ConflictError is left to throw so SQS
 * retries the message once the sync releases its claim, rather than dropping a delivery GitHub
 * will not resend on its own.
 */
export const dispatch = dispatchWithLogger(async (event, context, logger) => {
  const record = event.Records[0];
  if (!record) {
    logger.warn('Skipping github-lake-revoke event with no records');
    return;
  }
  let connectionId: string | undefined;
  try {
    ({ connectionId } = Payload.parse(JSON.parse(record.body)));
    logger.updateMetadata({ handler: 'githubLakeRevoke', connectionId });
    await revokeGitHubLakeConnection(connectionId, logger);
  } catch (err) {
    if (err instanceof ZodError || err instanceof SyntaxError) {
      logger.warn(`Skipping github-lake-revoke message: ${err.message}`);
      return;
    }
    if (err instanceof ConflictError) {
      logger.warn('[githubLakeRevoke] sync in progress; message will retry', { connectionId });
    }
    throw err;
  }
});
