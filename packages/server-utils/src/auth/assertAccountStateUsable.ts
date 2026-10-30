import { userService } from '@bike4mind/services';
import {
  ACCOUNT_DISPUTE_PENDING_MESSAGE,
  ACCOUNT_SUSPENDED_MESSAGE,
} from '@bike4mind/services/userService/accountState';
import { ForbiddenError, UnauthorizedError } from '../utils/errors';

export function assertAccountStateUsable(user: Parameters<typeof userService.accountBlockReasons>[0]): void {
  switch (userService.accountBlockReasons(user)[0]) {
    case 'banned':
      throw new UnauthorizedError('User not found or banned');
    case 'disputePending':
      throw new ForbiddenError(ACCOUNT_DISPUTE_PENDING_MESSAGE);
    case 'suspended':
      throw new ForbiddenError(ACCOUNT_SUSPENDED_MESSAGE);
    default:
      return;
  }
}
