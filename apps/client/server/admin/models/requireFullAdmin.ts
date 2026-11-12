import { ForbiddenError, isFullAdmin } from '@bike4mind/common';

/** Routes that call this need full admin. Model settings keys save through /api/settings/update, which this does not guard. */
export function requireFullAdmin(req: { user?: Parameters<typeof isFullAdmin>[0] }): void {
  if (!isFullAdmin(req.user)) throw new ForbiddenError('Only full administrators can change model settings.');
}
