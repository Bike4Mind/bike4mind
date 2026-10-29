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

/**
 * Pays the activity drip for the current UTC day when that day qualifies; a day pays at most once.
 * Runs awaited inside the chat turn on purpose: a detached call can be dropped when the Lambda freezes.
 * The cheap exits come first so an unlocked, capped or already-paid account costs one user read.
 */
export async function unlockSignupGrantFromActivity(userId: string, now: Date = new Date()) {
  const user = await userRepository.findById(userId);
  const grant = user?.signupGrant;
  if (!user || !grant || grant.stage === 'pending_email' || grant.stage === 'unlocked') return noGrant();
  // One clock for both the drip day and the budget draw, so they cannot straddle UTC midnight.
  const day = (signupProtection.grantBudget?.now?.() ?? now).toISOString().slice(0, 10);
  if (grant.lastDripDay === day) return noGrant();
  const { dailyCredits, maxCredits } = await userService.resolveDripLimits(adminSettingsRepository);
  if (!(dailyCredits > 0) || !(maxCredits > 0) || (grant.dripCredits ?? 0) >= maxCredits) return noGrant();
  if (!(await qualifiesOnDay(user, day))) return noGrant();
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
