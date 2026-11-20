import {
  COHORT_SHADOW_DETECTORS,
  CreditHolderType,
  DETECTION_LINK_SPEND_DAYS,
  type CohortShadowDetector,
  type ShadowDetectionItem,
  type UserDetectionLinks,
} from '@bike4mind/common';
import type { UserLinkState } from '@bike4mind/database';
import { userService } from '@bike4mind/services';

/** Detections read per user; a cohort detection names at most a few dozen accounts. */
export const DETECTION_LINK_DETECTION_LIMIT = 20;
/** Accounts returned per user, so one sweeping detection cannot blow up the page. */
export const DETECTION_LINK_ACCOUNT_LIMIT = 100;

const DAY_MS = 24 * 60 * 60 * 1000;

export type DetectionLinkDeps = {
  listDetections: (
    userId: string,
    query: { detectors: readonly CohortShadowDetector[]; limit: number }
  ) => Promise<{ data: ShadowDetectionItem[]; truncated: boolean }>;
  findLinkStates: (ids: string[]) => Promise<UserLinkState[]>;
  aiSpendSince: (ownerIds: string[], ownerType: CreditHolderType, since: Date) => Promise<Record<string, number>>;
  countActiveApiKeys: (userIds: string[]) => Promise<Record<string, number>>;
  now: () => Date;
};

const isCohortDetector = (detector: string): detector is CohortShadowDetector =>
  (COHORT_SHADOW_DETECTORS as readonly string[]).includes(detector);

/**
 * The other accounts that cohort shadow detections (account campaign, signup network burst, signup IP
 * linked to a blocked account) name together with this user, with their spend, balance and live API keys.
 * Read-only: acting on them goes through the admin suspend path, one account at a time.
 */
export async function findDetectionLinkedAccounts(
  userId: string,
  deps: DetectionLinkDeps
): Promise<UserDetectionLinks> {
  const listed = await deps.listDetections(userId, {
    detectors: COHORT_SHADOW_DETECTORS,
    limit: DETECTION_LINK_DETECTION_LIMIT,
  });
  const detections = listed.data.flatMap(item =>
    isCohortDetector(item.detector) ? [{ ...item, detector: item.detector }] : []
  );

  const detectionIdsByAccount = new Map<string, string[]>();
  for (const detection of detections) {
    for (const memberId of detection.userIds) {
      if (memberId === userId) continue;
      detectionIdsByAccount.set(memberId, [...(detectionIdsByAccount.get(memberId) ?? []), detection.id]);
    }
  }
  const linkedIds = [...detectionIdsByAccount.keys()];
  const shownIds = linkedIds.slice(0, DETECTION_LINK_ACCOUNT_LIMIT);

  const since = new Date(deps.now().getTime() - DETECTION_LINK_SPEND_DAYS * DAY_MS);
  const [states, spend, apiKeys] = await Promise.all([
    deps.findLinkStates(shownIds),
    deps.aiSpendSince(shownIds, CreditHolderType.User, since),
    deps.countActiveApiKeys(shownIds),
  ]);

  // A deleted account drops out: it no longer has anything to act on.
  const accounts = states
    .map(state => ({
      id: state.id,
      name: state.name,
      email: state.email,
      signedUpAt: state.createdAt,
      blocked: userService.accountBlockReasons(state).length > 0,
      isBanned: state.isBanned,
      balance: state.currentCredits,
      spent: spend[state.id] ?? 0,
      activeApiKeys: apiKeys[state.id] ?? 0,
      detectionIds: detectionIdsByAccount.get(state.id) ?? [],
    }))
    .sort((a, b) => b.spent - a.spent || a.id.localeCompare(b.id));

  return {
    detections: detections.map(detection => ({
      id: detection.id,
      detector: detection.detector,
      summary: detection.summary,
      detectedAt: detection.detectedAt,
      verdict: detection.verdict,
      accountCount: detection.userIds.length,
    })),
    accounts,
    truncated: listed.truncated || linkedIds.length > shownIds.length,
  };
}
