import { SHADOW_DETECTION_LIST_LIMIT, type ShadowDetectionItem } from '@bike4mind/common';
import { AbuseAssessmentModel, User, mongoose, shadowDetectionRepository } from '@bike4mind/database';
import {
  AI_ADVISORY_WINDOW_HOURS,
  type AiAbuseAdvisory,
  type AiAdvisoryMailDomain,
  type AiAdvisoryNetwork,
  type AiAdvisorySummary,
} from '@client/app/utils/aiAdvisory';

const OBJECT_ID = /^[0-9a-f]{24}$/;
// Accounts and block candidates past these are cut; `truncated` says so.
const MAX_ADVISORIES = 500;
const MAX_BLOCK_CANDIDATES = 20;
const MIN_SHARED_ACCOUNTS = 2;

type LatestJudgment = {
  _id: string;
  result: string;
  probabilities: { value: string; probability: number }[];
  assessedAt: Date;
};

/**
 * The latest settled judgment per detection. An `unknown` (a failed or skipped call) never hides an
 * earlier judgment, so a provider outage cannot clear the advisory.
 */
async function latestJudgments(detectionIds: string[]): Promise<Map<string, LatestJudgment>> {
  const rows = await AbuseAssessmentModel.aggregate<LatestJudgment>([
    { $match: { detectionId: { $in: detectionIds }, result: { $ne: 'unknown' } } },
    { $sort: { assessedAt: -1, _id: -1 } },
    {
      $group: {
        _id: '$detectionId',
        result: { $first: '$result' },
        probabilities: { $first: '$probabilities' },
        assessedAt: { $first: '$assessedAt' },
      },
    },
  ]);
  return new Map(rows.map(row => [row._id, row]));
}

async function unsuspendedUserIds(userIds: string[]): Promise<Set<string>> {
  const ids = userIds.filter(id => OBJECT_ID.test(id)).map(id => new mongoose.Types.ObjectId(id));
  if (ids.length === 0) return new Set();
  const users = await User.find({ _id: { $in: ids }, isBanned: { $ne: true } })
    .select('_id')
    .lean();
  return new Set(users.map(user => String(user._id)));
}

const abuseProbabilityOf = (judgment: LatestJudgment): number | null =>
  judgment.probabilities.find(entry => entry.value === 'abuse')?.probability ?? null;

/** Strongest first; an unscored judgment ranks after every scored one, then newest first. */
const byStrength = (a: AiAbuseAdvisory, b: AiAbuseAdvisory) =>
  (b.abuseProbability ?? -1) - (a.abuseProbability ?? -1) || b.assessedAt.getTime() - a.assessedAt.getTime();

function networksOf(flagged: ShadowDetectionItem[], open: Set<string>): AiAdvisoryNetwork[] {
  const byIp = new Map<string, AiAdvisoryNetwork & { users: Set<string> }>();
  for (const detection of flagged) {
    const network = detection.network;
    if (!network?.ip) continue;
    const users = detection.userIds.filter(id => open.has(id));
    if (users.length === 0) continue;
    const entry = byIp.get(network.ip) ?? {
      ip: network.ip,
      country: network.country,
      asnOrg: network.asnOrg,
      hosting: network.hosting,
      accountCount: 0,
      detectorWouldBlock: false,
      users: new Set<string>(),
    };
    users.forEach(id => entry.users.add(id));
    entry.detectorWouldBlock ||= detection.wouldAction === 'blockIp';
    byIp.set(network.ip, entry);
  }
  return (
    [...byIp.values()]
      .map(({ users, ...entry }) => ({ ...entry, accountCount: users.size }))
      // One account behind one IP is weak grounds for a block: often a shared residential address.
      .filter(entry => entry.accountCount >= MIN_SHARED_ACCOUNTS || entry.detectorWouldBlock)
      .sort((a, b) => b.accountCount - a.accountCount)
      .slice(0, MAX_BLOCK_CANDIDATES)
  );
}

function mailDomainsOf(flagged: ShadowDetectionItem[], open: Set<string>): AiAdvisoryMailDomain[] {
  const byDomain = new Map<string, Set<string>>();
  for (const detection of flagged) {
    for (const evidence of detection.group?.evidence ?? []) {
      if (evidence.relationship !== 'mailDomain' || !evidence.value) continue;
      const users = byDomain.get(evidence.value) ?? new Set<string>();
      evidence.userIds.filter(id => open.has(id)).forEach(id => users.add(id));
      byDomain.set(evidence.value, users);
    }
  }
  return [...byDomain.entries()]
    .filter(([, users]) => users.size >= MIN_SHARED_ACCOUNTS)
    .map(([domain, users]) => ({ domain, accountCount: users.size }))
    .sort((a, b) => b.accountCount - a.accountCount)
    .slice(0, MAX_BLOCK_CANDIDATES);
}

/**
 * Accounts on unreviewed detections from the last day whose latest AI assessment says `abuse`, plus
 * the signup IPs and campaign mail domains those detections share. Read-only and advisory: an admin
 * acts through bulk Contain or the Blocked IPs list. Suspended accounts drop out, so containing them
 * clears the advisory. The admin dashboard strip, the Users list's `aiVerdict` filter and its badge
 * all read this one function, so they always agree.
 */
export async function listAiAbuseAdvisories(now = new Date()): Promise<AiAdvisorySummary> {
  const since = new Date(now.getTime() - AI_ADVISORY_WINDOW_HOURS * 60 * 60 * 1000);
  const fetched = await shadowDetectionRepository.listUnreviewedSince(since, SHADOW_DETECTION_LIST_LIMIT + 1);
  let truncated = fetched.length > SHADOW_DETECTION_LIST_LIMIT;
  const detections = fetched.slice(0, SHADOW_DETECTION_LIST_LIMIT);
  if (detections.length === 0) return { since, advisories: [], networks: [], mailDomains: [], truncated };

  const judgments = await latestJudgments(detections.map(detection => detection.id));
  const flagged = detections.filter(detection => judgments.get(detection.id)?.result === 'abuse');
  const open = await unsuspendedUserIds([...new Set(flagged.flatMap(detection => detection.userIds))]);

  const strongest = new Map<string, AiAbuseAdvisory>();
  for (const detection of flagged) {
    const judgment = judgments.get(detection.id);
    if (!judgment) continue;
    for (const userId of detection.userIds) {
      if (!open.has(userId)) continue;
      const candidate: AiAbuseAdvisory = {
        userId,
        detectionId: detection.id,
        detector: detection.detector,
        abuseProbability: abuseProbabilityOf(judgment),
        assessedAt: judgment.assessedAt,
      };
      const current = strongest.get(userId);
      if (!current || byStrength(candidate, current) < 0) strongest.set(userId, candidate);
    }
  }
  const advisories = [...strongest.values()].sort(byStrength);
  truncated ||= advisories.length > MAX_ADVISORIES;
  return {
    since,
    advisories: advisories.slice(0, MAX_ADVISORIES),
    networks: networksOf(flagged, open),
    mailDomains: mailDomainsOf(flagged, open),
    truncated,
  };
}
