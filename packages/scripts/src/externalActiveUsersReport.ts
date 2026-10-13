import mongoose from 'mongoose';
import { Quest, UsageEvent, User } from '@bike4mind/database';
import {
  buildExclusionRules,
  buildReport,
  formatReport,
  recordActivity,
  recordUsageSource,
  toUtcDay,
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

interface QuestActivityRow {
  timestamp: Date;
  promptMeta?: { session?: { userId?: string } };
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/**
 * Streams the three activity sources from `windowStart` into one user-day map. Projects only the
 * fields it needs and never unions across collections (DocumentDB has no $unionWith).
 */
async function collectActivity(windowStart: Date, batchSize: number) {
  const userDays: UserDayMap = new Map();
  const sourceCounts: UserSourceCounts = new Map();

  const usageEvents = UsageEvent.find(
    { status: 'ok', createdAt: { $gte: windowStart } },
    { userId: 1, createdAt: 1, source: 1, _id: 0 }
  )
    .lean<ActivityRow[]>()
    .cursor({ batchSize });
  for await (const event of usageEvents) {
    if (!event.userId) continue;
    recordActivity(userDays, event.userId, event.createdAt);
    recordUsageSource(sourceCounts, event.userId, event.source);
  }

  // The user is promptMeta.session.userId: a Quest has no top-level userId. Soft-deleted quests are
  // skipped by the model's default filter, which also keeps this on the { deletedAt, timestamp } index.
  const quests = Quest.find(
    { type: 'message', timestamp: { $gte: windowStart } },
    { 'promptMeta.session.userId': 1, timestamp: 1, _id: 0 }
  )
    .lean<QuestActivityRow[]>()
    .cursor({ batchSize });
  for await (const quest of quests) {
    const userId = quest.promptMeta?.session?.userId;
    if (userId) recordActivity(userDays, userId, quest.timestamp);
  }

  // Not a named export of @bike4mind/database, but importing it registers the model. 90-day TTL.
  const AgentExecution = mongoose.model('AgentExecution');
  const executions = AgentExecution.find({ createdAt: { $gte: windowStart } }, { userId: 1, createdAt: 1, _id: 0 })
    .lean<ActivityRow[]>()
    .cursor({ batchSize });
  for await (const execution of executions) {
    if (execution.userId) recordActivity(userDays, execution.userId, execution.createdAt);
  }

  return { userDays, sourceCounts };
}

/** Only the exclusion inputs. Ids that are not ObjectIds can never match a User, so they are not queried. */
async function loadUsers(userIds: string[], batchSize: number): Promise<Map<string, UserRecord>> {
  const users = new Map<string, UserRecord>();
  const valid = userIds.filter(id => OBJECT_ID_RE.test(id));
  for (let i = 0; i < valid.length; i += batchSize) {
    const batch = valid.slice(i, i + batchSize).map(id => new mongoose.Types.ObjectId(id));
    const docs = await User.find({ _id: { $in: batch } }, { email: 1, isAdmin: 1 }).lean();
    for (const doc of docs) users.set(String(doc._id), { email: doc.email, isAdmin: doc.isAdmin });
  }
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

  const windowStart = new Date((toUtcDay(now) - days + 1) * 86_400_000);
  const { userDays, sourceCounts } = await collectActivity(windowStart, batchSize);
  const users = await loadUsers([...userDays.keys()], batchSize);

  const report = buildReport({
    userDays,
    sourceCounts,
    users,
    rules: buildExclusionRules(staffDomainsEnv, testPattern),
    days,
    now,
  });
  log(formatReport(report));
  return report;
}
