import mongoose from 'mongoose';
import { Quest, UsageEvent, User } from '@bike4mind/database';
import {
  buildExclusionRules,
  buildReport,
  formatReport,
  isApiSource,
  isOriginalQuest,
  recordActivity,
  recordUsageSource,
  windowStartDay,
  type ExternalActivityReport,
  type UserDayMap,
  type UserRecord,
  type UserSourceCounts,
} from './externalActiveUsers';

export interface ExternalActivityOptions {
  days: number;
  testPattern: RegExp;
  /** Raw NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS value; defaults to the process env. */
  staffDomainsEnv?: string;
  now?: Date;
  /** Docs per cursor batch and ids per User lookup. */
  batchSize?: number;
  log?: (message: string) => void;
}

interface ActivityRow {
  userId?: string;
  createdAt: Date;
  source?: string | null;
  apiKeyId?: string | null;
}

interface AgentActivityRow {
  _id: unknown;
  userId?: string;
  createdAt: Date;
  apiKeyId?: string | null;
}

interface QuestActivityRow {
  _id: { getTimestamp(): Date };
  timestamp: Date;
  agentExecutionId?: string;
  sessionId?: string;
  type: 'message' | 'error';
  promptMeta?: { session?: { userId?: string } };
}

export type MessageAttempt = {
  userId: string;
  at: Date;
  sessionId?: string;
  outcome: 'failed' | 'recorded';
};

type MessageCollectionOptions = {
  includeFailedAttempts: boolean;
  onAttempt: (attempt: MessageAttempt) => void;
};

type ActivityFilter = {
  include?: (at: Date, source?: string | null) => boolean;
  excludedApiKeyIds?: ReadonlySet<string>;
  excludedSessionIds?: ReadonlySet<string>;
};

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Streams the three activity sources from `windowStart` into two user-day maps: app, CLI and
 * desktop activity (DAU) and public API activity (reported separately). Projects only the fields
 * it needs and never unions across collections (DocumentDB has no $unionWith). Every read prefers
 * a secondary: a full-window scan of the largest collections should not load the primary.
 * `userIds`, when given, drops every other user's rows as they stream (not pushed into the query,
 * where a large $in would not ride the time-range indexes).
 */
export async function collectActivity(
  windowStart: Date,
  batchSize: number,
  windowEnd = new Date(),
  apiSessionIds: ReadonlySet<string> = new Set(),
  userIds?: ReadonlySet<string>,
  messageCollection?: MessageCollectionOptions,
  filter: ActivityFilter = {}
) {
  const includeActivity = filter.include ?? (() => true);
  const excludedKey = (id?: string | null) => !!id && filter.excludedApiKeyIds?.has(id);
  const included = (userId: string | undefined): userId is string =>
    !!userId && (userIds === undefined || userIds.has(userId));
  const userDays: UserDayMap = new Map();
  const apiUserDays: UserDayMap = new Map();
  const sourceCounts: UserSourceCounts = new Map();

  const usageEvents = UsageEvent.find(
    { status: 'ok', createdAt: { $gte: windowStart, $lt: windowEnd } },
    { userId: 1, createdAt: 1, source: 1, apiKeyId: 1, _id: 0 }
  )
    .read('secondaryPreferred')
    .lean<ActivityRow[]>()
    .cursor({ batchSize });
  for await (const event of usageEvents) {
    if (!included(event.userId) || excludedKey(event.apiKeyId) || !includeActivity(event.createdAt, event.source))
      continue;
    recordActivity(isApiSource(event.source) ? apiUserDays : userDays, event.userId, event.createdAt);
    recordUsageSource(sourceCounts, event.userId, event.source);
  }

  // Not a named export: the @bike4mind/database import registers this model as a side effect, so
  // that import must stay a value import (a type-only import is elided). 90-day TTL.
  // No status filter: starting a run is the user's action, a failure is ours. apiKeyId is stamped
  // only on API-key-authed starts (the web app authenticates with a JWT), so it marks API runs.
  // Read before the Quests so the Quests those runs wrote can be told apart below.
  const AgentExecution = mongoose.model('AgentExecution');
  const apiExecutionIds = new Set<string>();
  const excludedExecutionIds = new Set<string>();
  const executions = AgentExecution.find(
    { createdAt: { $gte: windowStart, $lt: windowEnd } },
    { userId: 1, createdAt: 1, apiKeyId: 1 }
  )
    .read('secondaryPreferred')
    .lean<AgentActivityRow[]>()
    .cursor({ batchSize });
  for await (const execution of executions) {
    if (!included(execution.userId)) continue;
    if (excludedKey(execution.apiKeyId)) {
      excludedExecutionIds.add(String(execution._id));
      continue;
    }
    if (execution.apiKeyId) apiExecutionIds.add(String(execution._id));
    if (!includeActivity(execution.createdAt)) continue;
    if (execution.apiKeyId) {
      recordActivity(apiUserDays, execution.userId, execution.createdAt);
    } else {
      recordActivity(userDays, execution.userId, execution.createdAt);
    }
  }

  // The user is promptMeta.session.userId: a Quest has no top-level userId. Soft-deleted quests are
  // skipped by the model's default filter, which also keeps this on the { deletedAt, timestamp } index.
  // Copied quests (clone, fork, snip) are dropped by isOriginalQuest, so _id is projected.
  // A Quest carries no API-key marker of its own, so POST /api/chat turns count as app activity;
  // only a Quest written by an API-key agent run is told apart, via agentExecutionId.
  // The census consumes projected attempts in this same pass, avoiding a scan per user batch.
  // Failed attempts are opt-in so the legacy activity report keeps its existing definition.
  const quests = Quest.find(
    {
      type: messageCollection?.includeFailedAttempts ? { $in: ['message', 'error'] } : 'message',
      timestamp: { $gte: windowStart, $lt: windowEnd },
    },
    { 'promptMeta.session.userId': 1, timestamp: 1, agentExecutionId: 1, sessionId: 1, type: 1 }
  )
    .read('secondaryPreferred')
    .lean<QuestActivityRow[]>()
    .cursor({ batchSize });
  for await (const quest of quests) {
    if (quest.sessionId && filter.excludedSessionIds?.has(quest.sessionId)) continue;
    if (quest.agentExecutionId && excludedExecutionIds.has(quest.agentExecutionId)) continue;
    const userId = quest.promptMeta?.session?.userId;
    if (!included(userId) || !isOriginalQuest(quest._id, quest.timestamp) || !includeActivity(quest.timestamp))
      continue;
    const viaApi =
      (quest.sessionId !== undefined && apiSessionIds.has(quest.sessionId)) ||
      (quest.agentExecutionId !== undefined && apiExecutionIds.has(quest.agentExecutionId));
    recordActivity(viaApi ? apiUserDays : userDays, userId, quest.timestamp);
    if (!viaApi)
      messageCollection?.onAttempt({
        userId,
        at: quest.timestamp,
        sessionId: quest.sessionId,
        outcome: quest.type === 'error' ? 'failed' : 'recorded',
      });
  }

  return { userDays, apiUserDays, sourceCounts, apiExecutionIds };
}

const USER_FIELDS = { email: 1, isAdmin: 1, isSynthetic: 1, createdAt: 1 };

interface UserDoc {
  _id: unknown;
  email?: string | null;
  isAdmin?: boolean | null;
  isSynthetic?: boolean | null;
  createdAt?: Date | null;
}

const toUserRecord = (doc: UserDoc): UserRecord => ({
  email: doc.email,
  isAdmin: doc.isAdmin,
  isSynthetic: doc.isSynthetic,
  createdAt: doc.createdAt,
});

/**
 * The exclusion inputs plus createdAt for every active user, then every user created since
 * `windowStart`: a signup with no activity is in no user-day map but still counts in its cohort.
 * Ids that are not ObjectIds can never match a User, so they are not queried.
 */
async function loadUsers(userIds: string[], windowStart: Date, batchSize: number): Promise<Map<string, UserRecord>> {
  const users = new Map<string, UserRecord>();
  const valid = userIds.filter(id => OBJECT_ID_RE.test(id));
  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize).map(id => new mongoose.Types.ObjectId(id));
    const docs = await User.find({ _id: { $in: batch } }, USER_FIELDS)
      .read('secondaryPreferred')
      .lean<UserDoc[]>();
    for (const doc of docs) users.set(String(doc._id), toUserRecord(doc));
  }

  const signups = User.find({ createdAt: { $gte: windowStart } }, USER_FIELDS)
    .read('secondaryPreferred')
    .lean<UserDoc[]>()
    .cursor({ batchSize });
  for await (const doc of signups) users.set(String(doc._id), toUserRecord(doc));
  return users;
}

/** Read-only: queries and prints, never writes. */
export async function runExternalActivityReport(options: ExternalActivityOptions): Promise<ExternalActivityReport> {
  const {
    days,
    testPattern,
    staffDomainsEnv = process.env.NEXT_PUBLIC_INTERNAL_STAFF_DOMAINS,
    now = new Date(),
    batchSize = 1000,
    log = console.log,
  } = options;

  const windowStart = windowStartDay(now, days);
  const { userDays, apiUserDays, sourceCounts } = await collectActivity(windowStart, batchSize, now);
  const users = await loadUsers([...new Set([...userDays.keys(), ...apiUserDays.keys()])], windowStart, batchSize);

  const report = buildReport({
    userDays,
    apiUserDays,
    sourceCounts,
    users,
    rules: buildExclusionRules(staffDomainsEnv, testPattern),
    days,
    now,
  });
  log(formatReport(report));
  return report;
}
