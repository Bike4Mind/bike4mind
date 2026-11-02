import { userService } from '@bike4mind/services';
import {
  ACCOUNT_DELETION_PENDING_MESSAGE,
  ACCOUNT_DISPUTE_PENDING_MESSAGE,
  ACCOUNT_SUSPENDED_MESSAGE,
} from '@bike4mind/services/userService/accountState';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

/**
 * `allowDeletionPending` admits an account whose owner asked to delete it. Only the browser session
 * surfaces pass it (verifyJwtPayload, refreshAccountGate): the auth chain then confines that session
 * to the restore-or-leave routes (apps/client/server/auth/auth.ts). Every other surface (API key, CLI,
 * WebSocket, embed) refuses it here.
 */
export function assertAccountStateUsable(
  user: Parameters<typeof userService.accountBlockReasons>[0],
  { allowDeletionPending = false }: { allowDeletionPending?: boolean } = {}
): void {
  switch (userService.accountBlockReasons(user)[0]) {
    case 'banned':
      throw new UnauthorizedError('User not found or banned');
    case 'disputePending':
      throw new ForbiddenError(ACCOUNT_DISPUTE_PENDING_MESSAGE);
    case 'suspended':
      throw new ForbiddenError(ACCOUNT_SUSPENDED_MESSAGE);
    case 'deletionPending':
      if (allowDeletionPending) return;
      throw new ForbiddenError(ACCOUNT_DELETION_PENDING_MESSAGE);
    default:
      return;
  }
}
