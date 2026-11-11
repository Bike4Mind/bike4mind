import { ForbiddenError, isFullAdmin } from '@bike4mind/common';

/** Every model administration write needs full admin; a delegate holding settings:manage gets 403. */
export function requireFullAdmin(req: { user?: Parameters<typeof isFullAdmin>[0] }): void {
  if (!isFullAdmin(req.user)) throw new ForbiddenError('Only full administrators can change model settings.');
}
