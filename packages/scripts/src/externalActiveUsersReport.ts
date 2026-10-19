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
  promptMeta?: { session?: { userId?: string } };
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Streams the three activity sources from `windowStart` into two user-day maps: app, CLI and
 * desktop activity (DAU) and public API activity (reported separately). Projects only the fields
 * it needs and never unions across collections (DocumentDB has no $unionWith). Every read prefers
 * a secondary: a full-window scan of the largest collections should not load the primary.
 */
async function collectActivity(windowStart: Date, batchSize: number) {
  const userDays: UserDayMap = new Map();
  const apiUserDays: UserDayMap = new Map();
  const sourceCounts: UserSourceCounts = new Map();

  const usageEvents = UsageEvent.find(
    { status: 'ok', createdAt: { $gte: windowStart } },
    { userId: 1, createdAt: 1, source: 1, _id: 0 }
  )
    .read('secondaryPreferred')
    .lean<ActivityRow[]>()
    .cursor({ batchSize });
  for await (const event of usageEvents) {
    if (!event.userId) continue;
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
  const executions = AgentExecution.find({ createdAt: { $gte: windowStart } }, { userId: 1, createdAt: 1, apiKeyId: 1 })
    .read('secondaryPreferred')
    .lean<AgentActivityRow[]>()
    .cursor({ batchSize });
  for await (const execution of executions) {
    if (!execution.userId) continue;
    if (execution.apiKeyId) {
      apiExecutionIds.add(String(execution._id));
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
  const quests = Quest.find(
    { type: 'message', timestamp: { $gte: windowStart } },
    { 'promptMeta.session.userId': 1, timestamp: 1, agentExecutionId: 1 }
  )
    .read('secondaryPreferred')
    .lean<QuestActivityRow[]>()
    .cursor({ batchSize });
  for await (const quest of quests) {
    const userId = quest.promptMeta?.session?.userId;
    if (!userId || !isOriginalQuest(quest._id, quest.timestamp)) continue;
    const viaApi = quest.agentExecutionId !== undefined && apiExecutionIds.has(quest.agentExecutionId);
    recordActivity(viaApi ? apiUserDays : userDays, userId, quest.timestamp);
  }

  return { userDays, apiUserDays, sourceCounts };
}

const USER_FIELDS = { email: 1, isAdmin: 1, createdAt: 1 };

interface UserDoc {
  _id: unknown;
  email?: string | null;
  isAdmin?: boolean | null;
  createdAt?: Date | null;
}

const toUserRecord = (doc: UserDoc): UserRecord => ({
  email: doc.email,
  isAdmin: doc.isAdmin,
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
  const { userDays, apiUserDays, sourceCounts } = await collectActivity(windowStart, batchSize);
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
