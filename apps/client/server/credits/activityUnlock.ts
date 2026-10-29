import { nonnegativeGrantCredits, type IUserDocument } from '@bike4mind/common';
import {
  adminSettingsRepository,
  creditLotRepository,
  creditTransactionRepository,
  Quest,
  userRepository,
} from '@bike4mind/database';
import { userService } from '@bike4mind/services';
import { signupProtection } from '@server/auth/signupProtection';

const DAY_MS = 86400000;
const noGrant = () => ({ creditsGranted: 0, currentCredits: null });

/** Whether the user completed enough first-party chat turns inside the given UTC day. */
async function qualifiesOnDay(user: IUserDocument, day: string): Promise<boolean> {
  const enabled = await adminSettingsRepository.findBySettingName('signupGrantActivityEnabled');
  if (enabled?.settingValue !== 'true' && (enabled?.settingValue as unknown) !== true) return false;
  const messages = nonnegativeGrantCredits(
    (await adminSettingsRepository.findBySettingName('signupGrantActivityMinMessages'))?.settingValue
  );
  if (!messages || messages > 10000) return false;
  const dayStart = new Date(`${day}T00:00:00.000Z`);
  const from = new Date(Math.max(dayStart.getTime(), new Date(user.createdAt).getTime()));
  const to = new Date(dayStart.getTime() + DAY_MS - 1);
  const rows = await Quest.aggregate<{ messages: number }>([
    {
      $match: {
        'signupActivity.userId': user.id,
        'signupActivity.startedAt': { $gte: from, $lte: to },
        status: 'done',
        type: 'message',
        deletedAt: null,
        $or: [{ reply: { $type: 'string', $ne: '' } }, { 'replies.0': { $type: 'string', $ne: '' } }],
      },
    },
    // Deduplicate provenance even if a copied/imported row retained it.
    { $group: { _id: '$signupActivity.turnId' } },
    { $count: 'messages' },
  ]).option({ maxTimeMS: 3000 });
  return (rows[0]?.messages ?? 0) >= messages;
}

/** Pays the activity drip for the current UTC day when that day qualifies; a day pays at most once. */
export async function unlockSignupGrantFromActivity(userId: string, now: Date = new Date()) {
  const user = await userRepository.findById(userId);
  if (!user?.signupGrant || user.signupGrant.stage === 'pending_email') return noGrant();
  const day = now.toISOString().slice(0, 10);
  if (user.signupGrant.lastDripDay === day || !(await qualifiesOnDay(user, day))) return noGrant();
  return userService.dripSignupGrant(userId, day, {
    db: {
      users: userRepository,
      signupProtection,
      adminSettings: adminSettingsRepository,
      creditTransactions: creditTransactionRepository,
      creditLots: creditLotRepository,
    },
    reason: 'Completed first-party chat activity',
  });
}
