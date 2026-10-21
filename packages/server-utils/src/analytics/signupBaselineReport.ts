import { CounterLog, CreditTransaction, Quest, Session, User } from '@bike4mind/database';
import { exclusionReason, isOriginalQuest, recordActivity } from './externalActiveUsers';
import { collectActivity } from './externalActiveUsersReport';
import {
  baselineRules,
  baselineWindowSchema,
  buildSignupBaseline,
  CENSUS_PRODUCT_EVENTS,
  DAY_MS,
  type BaselineWindow,
  type CensusEvent,
  type SignupAccount,
  type SignupEvidence,
} from './signupBaseline';

export type SignupBaselineOptions = BaselineWindow & { staffDomains: string | undefined; testPattern?: string };
type UserRow = Omit<SignupAccount, 'id' | 'signupMethod'> & {
  _id: unknown;
  acquisition?: { signupMethod?: string | null };
};
type SessionRow = {
  _id: unknown;
  userId: string;
  firstCreated: Date;
  origin?: { channel?: string };
  clonedSourceId?: string;
  forkedSourceId?: string;
};
type QuestRow = {
  _id: { getTimestamp(): Date };
  timestamp: Date;
  sessionId: string;
  agentExecutionId?: string;
  type: string;
  promptMeta?: { session?: { userId?: string } };
};
type GrantRow = { ownerId: string; createdAt: Date; credits: number; transactionId?: string };
type ProductEventRow = { userId: string; datetime: Date; counterName: string };
const BATCH_SIZE = 500;

function recordEvent(events: SignupEvidence['events'], userId: string, event: CensusEvent) {
  const accountEvents = events.get(userId) ?? [];
  accountEvents.push(event);
  events.set(userId, accountEvents);
}

/** Projected secondary reads only; no content, aggregation joins or database writes. */
export async function runSignupBaselineReport(options: SignupBaselineOptions) {
  const window = baselineWindowSchema.parse(options);
  const rules = baselineRules(options.staffDomains, options.testPattern);
  const trailingStart = new Date(window.until.getTime() - 90 * DAY_MS);
  const readStart = new Date(Math.min(window.since.getTime(), trailingStart.getTime()));
  const accounts: SignupAccount[] = [];
  let trailing90DaySignups = 0;
  const users = User.find(
    { createdAt: { $gte: readStart, $lt: window.until } },
    { email: 1, isAdmin: 1, isSynthetic: 1, createdAt: 1, 'acquisition.signupMethod': 1 }
  )
    .read('secondaryPreferred')
    .lean<UserRow[]>()
    .cursor({ batchSize: BATCH_SIZE });
  for await (const user of users) {
    if (exclusionReason(user, rules) === null && user.createdAt >= trailingStart) trailing90DaySignups++;
    if (user.createdAt >= window.since)
      accounts.push({
        id: String(user._id),
        email: user.email,
        isAdmin: user.isAdmin,
        isSynthetic: user.isSynthetic,
        createdAt: user.createdAt,
        signupMethod: user.acquisition?.signupMethod,
      });
  }

  const externalIds = accounts.filter(account => exclusionReason(account, rules) === null).map(account => account.id);
  const evidence: SignupEvidence = { userDays: new Map(), events: new Map(), firstSessions: new Map() };
  if (externalIds.length === 0)
    return buildSignupBaseline({ accounts, evidence, window, ...options, trailing90DaySignups });

  const dateRange = { $gte: window.since, $lt: window.until };
  const apiSessions = new Set<string>();
  for (let offset = 0; offset < externalIds.length; offset += BATCH_SIZE) {
    const userIds = externalIds.slice(offset, offset + BATCH_SIZE);
    const sessions = Session.find(
      { deletedAt: null, userId: { $in: userIds }, firstCreated: dateRange },
      { userId: 1, firstCreated: 1, origin: 1, clonedSourceId: 1, forkedSourceId: 1 }
    )
      .read('secondaryPreferred')
      .lean<SessionRow[]>()
      .cursor({ batchSize: BATCH_SIZE });
    for await (const session of sessions) {
      const id = String(session._id);
      if (session.origin?.channel === 'api') {
        apiSessions.add(id);
        continue;
      }
      if (session.clonedSourceId || session.forkedSourceId) continue;
      const previous = evidence.firstSessions.get(session.userId);
      if (
        !previous ||
        session.firstCreated < previous.at ||
        (session.firstCreated.getTime() === previous.at.getTime() && id < previous.id)
      ) {
        evidence.firstSessions.set(session.userId, { id, at: session.firstCreated });
      }
      recordEvent(evidence.events, session.userId, {
        at: session.firstCreated,
        kind: 'session_created',
        sessionId: id,
      });
    }
  }

  const { userDays, apiExecutionIds } = await collectActivity(
    window.since,
    BATCH_SIZE,
    window.until,
    apiSessions,
    new Set(externalIds)
  );
  evidence.userDays = userDays;
  for (let offset = 0; offset < externalIds.length; offset += BATCH_SIZE) {
    const userIds = externalIds.slice(offset, offset + BATCH_SIZE);
    const quests = Quest.find(
      { 'promptMeta.session.userId': { $in: userIds }, type: { $in: ['message', 'error'] }, timestamp: dateRange },
      { timestamp: 1, sessionId: 1, 'promptMeta.session.userId': 1, agentExecutionId: 1, type: 1 }
    )
      .read('secondaryPreferred')
      .lean<QuestRow[]>()
      .cursor({ batchSize: BATCH_SIZE });
    for await (const quest of quests) {
      const userId = quest.promptMeta?.session?.userId;
      if (
        !userId ||
        !isOriginalQuest(quest._id, quest.timestamp) ||
        apiSessions.has(quest.sessionId) ||
        (quest.agentExecutionId && apiExecutionIds.has(quest.agentExecutionId))
      )
        continue;
      recordActivity(evidence.userDays, userId, quest.timestamp);
      recordEvent(evidence.events, userId, {
        at: quest.timestamp,
        kind: 'message_sent',
        sessionId: quest.sessionId,
        outcome: quest.type === 'error' ? 'failed' : 'recorded',
      });
    }

    const grants = CreditTransaction.find(
      { ownerId: { $in: userIds }, ownerType: 'User', type: 'generic_add', createdAt: dateRange },
      { ownerId: 1, createdAt: 1, credits: 1, transactionId: 1, _id: 0 }
    )
      .read('secondaryPreferred')
      .lean<GrantRow[]>()
      .cursor({ batchSize: BATCH_SIZE });
    for await (const grant of grants) {
      if (
        grant.transactionId !== `verify-grant:${grant.ownerId}` &&
        grant.transactionId !== `otc-register-grant:${grant.ownerId}`
      )
        continue;
      recordEvent(evidence.events, grant.ownerId, {
        at: grant.createdAt,
        kind: 'signup_credit_grant',
        credits: grant.credits,
      });
    }

    const productEvents = CounterLog.find(
      { userId: { $in: userIds }, datetime: dateRange, counterName: { $in: [...CENSUS_PRODUCT_EVENTS] } },
      { userId: 1, datetime: 1, counterName: 1, _id: 0 }
    )
      .read('secondaryPreferred')
      .lean<ProductEventRow[]>()
      .cursor({ batchSize: BATCH_SIZE });
    for await (const event of productEvents) {
      recordEvent(evidence.events, event.userId, { at: event.datetime, kind: event.counterName });
    }
  }
  return buildSignupBaseline({ ...options, accounts, evidence, window, trailing90DaySignups });
}
