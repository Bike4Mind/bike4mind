import { adminSettingsRepository, userRepository } from '@bike4mind/database';

const positive = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;

/**
 * The daily cap on what all of a user's loops spend together: the lower of the admin
 * `LoopsDailyCreditsPerUser` (0 = none) and the user's own `loopsDailyCredits`. `effective` is undefined
 * when neither is set. Shared by the loop scheduler and the loops budget route.
 */
export async function userLoopsDailyCap(
  userId: string
): Promise<{ admin?: number; user?: number; effective?: number }> {
  const [adminValue, user] = await Promise.all([
    adminSettingsRepository.getSettingsValue('LoopsDailyCreditsPerUser'),
    userRepository.findById(userId),
  ]);
  const admin = positive(adminValue);
  const own = positive(user?.loopsDailyCredits);
  const set = [admin, own].filter((cap): cap is number => cap !== undefined);
  return { admin, user: own, effective: set.length > 0 ? Math.min(...set) : undefined };
}
