import { Types } from 'mongoose';
import {
  CREDIT_TRANSACTION_KIND,
  CreditHolderType,
  signedCredits,
  type AuditLogCursor,
  type CreditTransactionType,
  type UserTimelineSpendEntry,
} from '@bike4mind/common';
import { CreditTransaction, creditTransactionRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { loadLedgerWriteOffs, writtenOffNewerThan, type LedgerWriteOffs } from './ledgerWriteOffs';

/**
 * Most ledger rows one spend page reads. Grouping happens here rather than in Mongo so that read stays
 * a bounded index scan. The balance-after walk is not bounded: each page also sums every ledger row
 * newer than it (sumSignedCreditsNewerThan), so its cost grows with how deep the admin pages.
 */
export const SPEND_READ_LIMIT = 2000;

const HOUR_MS = 60 * 60 * 1000;
const QUERY_MAX_TIME_MS = 15_000;
const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

export type SpendLedgerRow = {
  _id: Types.ObjectId;
  type: CreditTransactionType;
  credits: number;
  createdAt: Date;
  model?: string;
  sessionId?: string;
  source?: string;
  apiKeyId?: string;
  questId?: string;
  /** Part of this row's cost written off on a capped turn (see ledgerWriteOffs); the rest was charged. */
  writtenOffCredits?: number;
};

export type SpendGroup = Omit<UserTimelineSpendEntry, 'summary' | 'detail' | 'alert' | 'type'>;

const hourStart = (at: Date): number => Math.floor(at.getTime() / HOUR_MS) * HOUR_MS;

const isUsageRow = (row: SpendLedgerRow): boolean => {
  const kind = CREDIT_TRANSACTION_KIND[row.type];
  return kind === 'usage' || kind === 'api';
};

const groupKey = (row: SpendLedgerRow): string =>
  [hourStart(row.createdAt), row.sessionId, row.model, row.type, row.source, row.apiKeyId].join('|');

/**
 * Rolls usage rows (newest first) into one group per hour, notebook, model, type, source and key.
 * Every row, usage or not, moves the running balance, so each group gets the balance right after its
 * newest charge. When the read was truncated the oldest hour may be missing rows: its groups are
 * dropped, unless they are all there is, in which case they are kept and marked partial.
 */
export const rollUpSpend = (
  rows: readonly SpendLedgerRow[],
  { balanceAfterNewest, truncated }: { balanceAfterNewest?: number; truncated: boolean }
): SpendGroup[] => {
  const groups = new Map<string, SpendGroup & { hour: number }>();
  let balance = balanceAfterNewest;

  for (const row of rows) {
    const writtenOff = row.writtenOffCredits ?? 0;
    if (isUsageRow(row)) {
      const key = groupKey(row);
      const credits = Math.abs(row.credits) - writtenOff;
      const group = groups.get(key);
      if (group) {
        group.credits += credits;
        group.calls += 1;
        group.firstAt = row.createdAt;
        // A receipt is per request, so only a single-charge group links to one.
        group.requestId = undefined;
        if (writtenOff > 0) group.writtenOffCredits = (group.writtenOffCredits ?? 0) + writtenOff;
      } else {
        groups.set(key, {
          id: row._id.toHexString(),
          at: row.createdAt,
          firstAt: row.createdAt,
          hour: hourStart(row.createdAt),
          credits,
          calls: 1,
          transactionType: row.type,
          model: row.model || undefined,
          notebookId: row.sessionId || undefined,
          source: row.source || undefined,
          apiKeyId: row.apiKeyId || undefined,
          requestId: row.questId || undefined,
          writtenOffCredits: writtenOff > 0 ? writtenOff : undefined,
          balanceAfter: balance,
          partial: false,
        });
      }
    }
    if (balance !== undefined) balance -= signedCredits(row.type, row.credits) + writtenOff;
  }

  const all = [...groups.values()];
  const oldest = rows[rows.length - 1];
  if (!truncated || !oldest) return all.map(({ hour: _hour, ...group }) => group);

  const oldestHour = hourStart(oldest.createdAt);
  const complete = all.filter(group => group.hour !== oldestHour);
  const kept = complete.length > 0 ? complete : all.map(group => ({ ...group, partial: true }));
  return kept.map(({ hour: _hour, ...group }) => group);
};

const isOlderThanCursor = (group: SpendGroup, cursor: AuditLogCursor | undefined): boolean => {
  if (!cursor) return true;
  const byTime = group.at.getTime() - cursor.occurredAt.getTime();
  return byTime < 0 || (byTime === 0 && group.id < cursor.id);
};

const compareNewestFirst = (a: SpendGroup, b: SpendGroup): number =>
  b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

type SpendPageOptions = {
  ownerId: string;
  currentBalance: number;
  limit: number;
  cursor?: AuditLogCursor;
  range: { from?: Date; to?: Date };
};

const readLedger = async (ownerId: string, range: SpendPageOptions['range'], before?: Date) => {
  const createdAt: Record<string, Date> = {};
  if (range.from) createdAt.$gte = range.from;
  if (range.to) createdAt.$lte = range.to;
  if (before) createdAt.$lt = before;
  const rows = await CreditTransaction.find({
    ownerId,
    ownerType: CreditHolderType.User,
    ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
  })
    .select('_id type credits createdAt model sessionId source apiKeyId questId')
    .sort({ createdAt: -1, _id: -1 })
    .limit(SPEND_READ_LIMIT + 1)
    .maxTimeMS(QUERY_MAX_TIME_MS)
    .lean<SpendLedgerRow[]>();
  return { rows: rows.slice(0, SPEND_READ_LIMIT), truncated: rows.length > SPEND_READ_LIMIT };
};

/**
 * The spend groups older than the cursor. A group's rows can straddle the cursor, so the read starts
 * at the end of the cursor's hour and the groups are filtered by their own (at, id) afterwards.
 */
export const listSpendGroups = async ({
  ownerId,
  currentBalance,
  limit,
  cursor,
  range,
}: SpendPageOptions): Promise<{ groups: SpendGroup[]; hasMore: boolean }> => {
  const cursorHourEnd = cursor ? new Date(hourStart(cursor.occurredAt) + HOUR_MS) : undefined;
  const [writeOffs, firstRead] = await Promise.all([
    loadLedgerWriteOffs(ownerId),
    readLedger(ownerId, range, cursorHourEnd),
  ]);
  let read = firstRead;
  let groups = await groupsFrom(read.rows, read.truncated, ownerId, currentBalance, writeOffs);
  let older = groups.filter(group => isOlderThanCursor(group, cursor));

  // One hour busier than a whole read: what was shown of it is all there is, so continue below it.
  // Groups of that hour the first read never reached are skipped here, without a lower-bound marker.
  if (cursor && older.length === 0 && read.truncated) {
    read = await readLedger(ownerId, range, new Date(hourStart(cursor.occurredAt)));
    groups = await groupsFrom(read.rows, read.truncated, ownerId, currentBalance, writeOffs);
    older = groups.filter(group => isOlderThanCursor(group, cursor));
  }

  older.sort(compareNewestFirst);
  return { groups: older.slice(0, limit + 1), hasMore: older.length > limit || read.truncated };
};

const groupsFrom = async (
  rows: SpendLedgerRow[],
  truncated: boolean,
  ownerId: string,
  currentBalance: number,
  writeOffs: LedgerWriteOffs
): Promise<SpendGroup[]> => {
  const newest = rows[0];
  if (!newest) return [];
  const position = { createdAt: newest.createdAt, id: newest._id.toHexString() };
  const newerNet = await creditTransactionRepository.sumSignedCreditsNewerThan(
    ownerId,
    CreditHolderType.User,
    position
  );
  const withWriteOffs = rows.map(row => {
    const writtenOffCredits = writeOffs.byTransactionId.get(row._id.toHexString())?.writtenOffCredits;
    return writtenOffCredits ? { ...row, writtenOffCredits } : row;
  });
  return rollUpSpend(withWriteOffs, {
    balanceAfterNewest: currentBalance - (newerNet + writtenOffNewerThan(writeOffs, position)),
    truncated,
  });
};

export type SpendLookups = { apiKeyPrefixes: Map<string, string> };

/**
 * API key prefixes for a page of groups. Notebook names are deliberately not read: they are generated
 * from the user's first message, so the feed names a notebook by id only.
 */
export const loadSpendLookups = async (groups: readonly SpendGroup[]): Promise<SpendLookups> => {
  const apiKeyIds = [
    ...new Set(groups.map(group => group.apiKeyId).filter((id): id is string => !!id && OBJECT_ID_PATTERN.test(id))),
  ];
  const keys = await Promise.all(apiKeyIds.map(id => userApiKeyRepository.findById(id)));
  return {
    apiKeyPrefixes: new Map(
      keys.flatMap((key, index) => (key?.keyPrefix ? [[apiKeyIds[index], key.keyPrefix] as const] : []))
    ),
  };
};

const USAGE_NOUNS: Readonly<Partial<Record<CreditTransactionType, readonly [string, string]>>> = {
  text_generation_usage: ['chat message', 'chat messages'],
  image_generation_usage: ['image', 'images'],
  image_edit_usage: ['image edit', 'image edits'],
  video_generation_usage: ['video', 'videos'],
  realtime_voice_usage: ['voice session', 'voice sessions'],
  tool_usage: ['tool call', 'tool calls'],
  speech_to_text_usage: ['transcription', 'transcriptions'],
  text_to_speech_usage: ['speech clip', 'speech clips'],
  sound_effects_usage: ['sound effect', 'sound effects'],
  music_generation_usage: ['music track', 'music tracks'],
  completion_api_usage: ['API completion', 'API completions'],
  decision_usage: ['decision call', 'decision calls'],
};

const SOURCE_LABELS: Readonly<Record<string, string>> = {
  web: 'Web app',
  cli: 'CLI',
  desktop: 'Desktop app',
  api: 'API',
  agent: 'Agent',
  system: 'System',
};

const formatCredits = (credits: number): string => Math.round(credits).toLocaleString('en-US');

const formatSpan = (group: SpendGroup): string | undefined => {
  const minutes = Math.round((group.at.getTime() - group.firstAt.getTime()) / 60_000);
  return minutes >= 1 ? `over ${minutes} min` : undefined;
};

/** "Spent 2,400 credits: 14 chat messages on claude-opus", plus the meta line (notebook id, source, key, balance). */
export const spendGroupToEntry = (group: SpendGroup, lookups: SpendLookups): UserTimelineSpendEntry => {
  const [singular, plural] = USAGE_NOUNS[group.transactionType as CreditTransactionType] ?? ['charge', 'charges'];
  const calls = `${group.calls.toLocaleString('en-US')}${group.partial ? '+' : ''} ${group.calls === 1 ? singular : plural}`;
  const summary = [
    `Spent ${formatCredits(group.credits)}${group.partial ? '+' : ''} credits: ${calls}`,
    group.model ? ` on ${group.model}` : '',
  ].join('');
  const keyPrefix = group.apiKeyId ? lookups.apiKeyPrefixes.get(group.apiKeyId) : undefined;
  const detail = [
    group.writtenOffCredits ? `${formatCredits(group.writtenOffCredits)} written off` : undefined,
    group.notebookId ? `notebook ${group.notebookId}` : undefined,
    group.source ? (SOURCE_LABELS[group.source] ?? group.source) : undefined,
    group.apiKeyId ? `key ${keyPrefix ?? group.apiKeyId}` : undefined,
    formatSpan(group),
    group.balanceAfter !== undefined ? `balance after ${formatCredits(group.balanceAfter)}` : undefined,
  ]
    .filter(Boolean)
    .join(' \u00b7 ');
  const negative = group.balanceAfter !== undefined && group.balanceAfter < 0;
  return {
    type: 'spend',
    ...group,
    summary,
    detail: detail || undefined,
    flags: negative ? ['Negative balance'] : undefined,
    alert: negative || undefined,
  };
};
