import { nonnegativeGrantCredits } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  Quest,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

export async function unlockSignupGrantFromActivity(userId: string) {
  return userService.unlockSignupGrant(userId, 'activity', {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: 'Completed first-party chat activity',
    validators: {
      activity: async user => {
        const enabled = await adminSettingsRepository.findBySettingName('signupGrantActivityEnabled');
        if (enabled?.settingValue !== 'true' && (enabled?.settingValue as unknown) !== true) return false;
        const messages = nonnegativeGrantCredits(
          (await adminSettingsRepository.findBySettingName('signupGrantActivityMinMessages'))?.settingValue
        );
        const days = nonnegativeGrantCredits(
          (await adminSettingsRepository.findBySettingName('signupGrantActivityMinDays'))?.settingValue
        );
        if (!messages || !days || messages > 10000 || days > 365) return false;
        const rows = await Quest.aggregate<{ messages: number; days: string[]; first: Date; last: Date }>([
          {
            $match: {
              'signupActivity.userId': user.id,
              'signupActivity.startedAt': { $gte: new Date(user.createdAt), $lte: new Date() },
              status: 'done',
              type: 'message',
              deletedAt: null,
              $or: [{ reply: { $type: 'string', $ne: '' } }, { 'replies.0': { $type: 'string', $ne: '' } }],
            },
          },
          // Deduplicate provenance even if a copied/imported row retained it.
          { $group: { _id: '$signupActivity.turnId', at: { $min: '$signupActivity.startedAt' } } },
          {
            $group: {
              _id: null,
              messages: { $sum: 1 },
              days: { $addToSet: { $dateToString: { date: '$at', format: '%Y-%m-%d', timezone: 'UTC' } } },
              first: { $min: '$at' },
              last: { $max: '$at' },
            },
          },
        ]).option({ maxTimeMS: 3000 });
        const result = rows[0];
        return (
          !!result &&
          result.messages >= messages &&
          result.days.length >= days &&
          result.last.getTime() - result.first.getTime() >= (days - 1) * 86400000
        );
      },
    },
  });
}
