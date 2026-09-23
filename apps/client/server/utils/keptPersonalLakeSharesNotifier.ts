import { dataLakeService } from '@bike4mind/services';
import { dataLakeRepository, dataLakeAccessGrantRepository } from '@bike4mind/database';
import { userRepository } from '@bike4mind/database/auth';
import type { Logger } from '@bike4mind/observability';
import mailer from './mailer';

/**
 * Reads the departing member's surviving personal-lake shares and best-effort emails their owners.
 * Call after the departure's transaction commits - personal-lake grants are untouched by it, so a
 * post-commit read sees the same result, and calling once per route means a retried transaction
 * cannot mail twice. Never throws into the route: a report-read failure is logged and treated as
 * zero, same as the notify step it wraps.
 */
export async function reportAndNotifyKeptPersonalLakeShares(
  departedUserId: string,
  organizationName: string,
  logger?: Logger
): Promise<number> {
  let shares: dataLakeService.KeptPersonalLakeShares;
  try {
    shares = await dataLakeService.reportKeptPersonalLakeShares(departedUserId, {
      db: { dataLakes: dataLakeRepository, dataLakeAccessGrants: dataLakeAccessGrantRepository },
      logger,
    });
  } catch (err) {
    const warn = logger?.warn ? logger.warn.bind(logger) : console.warn;
    warn('[dataLakes] kept-personal-lake-share report failed', { error: String(err) });
    return 0;
  }

  await dataLakeService.notifyKeptPersonalLakeShares(
    shares,
    { departedUserId, organizationName, appUrl: process.env.APP_URL },
    { db: { users: userRepository }, mailer, logger }
  );

  return shares.lakeCount;
}
