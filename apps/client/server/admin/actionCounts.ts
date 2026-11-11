import {
  ADMIN_PERMISSIONS,
  hasAdminPermission,
  isFullAdmin,
  meetsAdminPermissionRequirement,
  MODERATION_PAGE_READ,
  type AdminPermissionId,
} from '@bike4mind/common';
import {
  adminApprovalRepository,
  adminAuditLogRepository,
  imageModerationIncidentRepository,
  modelDiscoveryStateRepository,
  publishedArtifactRepository,
  signupDomainHoldListRepository,
  signupGrantReleaseRepository,
  sreErrorTrackingRepository,
  stripeDisputeRepository,
  subscriberRepository,
  userRepository,
  countNewFeedback,
} from '@bike4mind/database';
import { secretRotationRepository } from '@bike4mind/database/infra';
import { Logger } from '@bike4mind/observability';
import { getDlqRegistry, getDlqUrl } from '@bike4mind/server-utils/utils/dlqRegistry';
import { getQueueAttributes } from '@bike4mind/server-utils/utils/sqs';
import { getSecretRotationConfig } from '@bike4mind/server-utils/lib/secretRotation/constants';
import {
  ADMIN_ACTION_COUNT_CAP,
  ADMIN_ACTION_COUNT_KEYS,
  type AdminActionCountAccess,
  type AdminActionCountKey,
  type AdminActionCounts,
} from '@client/app/components/admin/adminActionCounts';

export type AdminActionCountViewer = {
  id: string;
  isAdmin?: boolean | null;
  adminPermissions?: readonly string[] | null;
};

export type AdminActionCountContext = {
  viewer: AdminActionCountViewer;
  /** The real admin: under impersonation the impersonator, otherwise viewer.id. */
  viewerUserId: string;
  now: Date;
  /** Every counter stops at this, so a backlog never costs a full scan. */
  cap: number;
};

export type AdminActionCounter = {
  /** The access needed to read the queue. */
  access: AdminActionCountAccess;
  count: (context: AdminActionCountContext) => Promise<number>;
};

const DEAD_LETTER_CACHE_MS = 60_000;

let deadLetterCache: { total: number; expiresAt: number } | null = null;

export const resetDeadLetterCountCacheForTests = (): void => {
  deadLetterCache = null;
};

/** Visible messages across every registered DLQ; a queue that fails is skipped, and all failing rejects. */
const sumDeadLetters = async (): Promise<number> => {
  const registry = getDlqRegistry();
  if (registry.length === 0) return 0;
  const results = await Promise.allSettled(
    registry.map(async entry => (await getQueueAttributes(getDlqUrl(entry.label))).approximateMessageCount)
  );
  const counts = results.flatMap(result => (result.status === 'fulfilled' ? [result.value] : []));
  if (counts.length === 0) {
    const firstFailure = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    throw firstFailure?.reason ?? new Error('No dead-letter queue answered');
  }
  return counts.reduce((sum, count) => sum + Math.max(count, 0), 0);
};

// The badge is polled, and the registry is dozens of queues: one SQS fan-out per minute per instance.
const countDeadLetters = async ({ now, cap }: AdminActionCountContext): Promise<number> => {
  if (!deadLetterCache || deadLetterCache.expiresAt <= now.getTime()) {
    deadLetterCache = { total: await sumDeadLetters(), expiresAt: now.getTime() + DEAD_LETTER_CACHE_MS };
  }
  return Math.min(deadLetterCache.total, cap);
};

/** The permissions a viewer could decide an approval under; see canDecideAs in approvals/service.ts. */
const decidablePermissions = (viewer: AdminActionCountViewer): AdminPermissionId[] =>
  ADMIN_PERMISSIONS.filter(permission => hasAdminPermission(viewer, permission));

export const ADMIN_ACTION_COUNTERS: Record<AdminActionCountKey, AdminActionCounter> = {
  waitingSubscribers: {
    access: 'credits:adjust',
    count: ({ cap }) => subscriberRepository.countWaiting({ limit: cap }),
  },
  unreviewedAudit: {
    access: 'support:read',
    count: ({ viewerUserId, cap }) => adminAuditLogRepository.countUnreviewed({ viewerUserId }, { limit: cap }),
  },
  moderationReview: {
    access: 'fullAdmin',
    count: ({ cap }) => imageModerationIncidentRepository.countPendingReview({ limit: cap }),
  },
  heldSignupGrants: {
    access: 'credits:adjust',
    count: ({ cap }) => signupGrantReleaseRepository.countHeld(undefined, { limit: cap }),
  },
  signupDomainHolds: {
    access: MODERATION_PAGE_READ,
    count: ({ cap }) => signupDomainHoldListRepository.countPending({ limit: cap }),
  },
  signupRiskReview: {
    access: MODERATION_PAGE_READ,
    count: ({ cap }) => userRepository.countPendingRiskReviews({ limit: cap }),
  },
  approvals: {
    access: 'support:read',
    count: ({ viewer, viewerUserId, now, cap }) =>
      adminApprovalRepository.countDecidable({
        now,
        viewerIds: [...new Set([viewer.id, viewerUserId])],
        permissions: decidablePermissions(viewer),
        fullAdmin: isFullAdmin(viewer),
        limit: cap,
      }),
  },
  publishedPages: {
    access: MODERATION_PAGE_READ,
    count: ({ cap }) => publishedArtifactRepository.countReported({ limit: cap }),
  },
  stripeDisputes: {
    access: 'users:moderate',
    count: ({ cap }) => stripeDisputeRepository.countAdminResolvable({ limit: cap }),
  },
  modelLifecycle: {
    access: 'settings:manage',
    count: ({ cap }) => modelDiscoveryStateRepository.countPendingSuggestions({ limit: cap }),
  },
  secretRotation: {
    access: 'fullAdmin',
    // Only configured keys, as the Secret Rotation page hides rows for keys removed from the config.
    count: ({ now, cap }) =>
      secretRotationRepository.countOverdue({ now, keyNames: Object.keys(getSecretRotationConfig()), limit: cap }),
  },
  sreAgent: {
    access: 'settings:manage',
    count: ({ cap }) => sreErrorTrackingRepository.countFailed({ limit: cap }),
  },
  feedback: {
    access: 'fullAdmin',
    count: ({ cap }) => countNewFeedback({ limit: cap }),
  },
  deadLetters: {
    access: 'support:read',
    count: countDeadLetters,
  },
};

const canSee = (viewer: AdminActionCountViewer, access: AdminActionCountAccess): boolean =>
  access === 'fullAdmin' ? isFullAdmin(viewer) : meetsAdminPermissionRequirement(viewer, access);

/** Counts every queue the viewer may read, in parallel; a counter that throws is logged and reported as null. */
export async function computeAdminActionCounts(
  viewer: AdminActionCountViewer,
  viewerUserId: string,
  now: Date = new Date()
): Promise<AdminActionCounts> {
  const keys = ADMIN_ACTION_COUNT_KEYS.filter(key => canSee(viewer, ADMIN_ACTION_COUNTERS[key].access));
  const context: AdminActionCountContext = { viewer, viewerUserId, now, cap: ADMIN_ACTION_COUNT_CAP };
  const results = await Promise.allSettled(keys.map(key => ADMIN_ACTION_COUNTERS[key].count(context)));

  const counts: AdminActionCounts = {};
  results.forEach((result, index) => {
    const key = keys[index];
    if (result.status === 'fulfilled') {
      counts[key] = result.value;
      return;
    }
    Logger.error('[Admin] Action count failed', {
      key,
      error: result.reason instanceof Error ? result.reason.message : String(result.reason),
    });
    counts[key] = null;
  });
  return counts;
}
