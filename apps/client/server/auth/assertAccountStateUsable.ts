import type { IUserDocument } from '@bike4mind/common';
import { userService } from '@bike4mind/services';
import { ForbiddenError, UnauthorizedError } from '@server/utils/errors';

export function assertAccountStateUsable(user: IUserDocument): void {
  switch (userService.accountBlockReasons(user)[0]) {
    case 'banned':
      throw new UnauthorizedError('User not found or banned');
    case 'disputePending':
      throw new ForbiddenError('Account suspended pending dispute resolution. Please contact support.');
    case 'suspended':
      throw new ForbiddenError(
        'Your account is suspended for repeated content-policy violations. Please contact support to appeal.'
      );
    default:
      return;
  }
}
