import { createHash, timingSafeEqual } from 'node:crypto';
import { User, UsageEvent } from '@bike4mind/database';
import {
  FLEET_USAGE_DAY_MS,
  FLEET_USAGE_MAX_ROWS,
  FleetUsageExportQuerySchema,
  FleetUsageExportRowSchema,
  FleetUsageExportSchema,
  FleetUsageExportScopeSchema,
  type FleetUsageExport,
  type FleetUsageExportRow,
  type FleetUsageExportScope,
} from '@bike4mind/common';

/** A snapshot exceeded an event or row limit; the caller should request fewer days. */
export class FleetUsageExportTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FleetUsageExportTooLargeError';
  }
}

export function authorizeFleetUsageExport(
  authorization: string | undefined,
  env: { FLEET_USAGE_EXPORT_TOKEN?: string; FLEET_USAGE_EXPORT_SCOPE?: string }
): FleetUsageExportScope | null {
  const token = env.FLEET_USAGE_EXPORT_TOKEN;
  if (!token || token.length < 32 || token.trim() !== token || token.length > 4096) return null;
  if (!authorization || authorization.length > 4103) return null;
  const presented = /^Bearer (\S+)$/i.exec(authorization)?.[1];
  if (!presented) return null;
  const digest = (value: string) => createHash('sha256').update(value).digest();
  if (!timingSafeEqual(digest(token), digest(presented))) return null;
  try {
    const scope = FleetUsageExportScopeSchema.safeParse(JSON.parse(env.FLEET_USAGE_EXPORT_SCOPE ?? ''));
    return scope.success ? scope.data : null;
  } catch {
    return null;
  }
}

const sumFields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'costUsd',
  'creditsCharged',
  'writtenOffCredits',
  'requests',
] as const;

export async function readFleetUsageExport(
  scopeInput: FleetUsageExportScope,
  query: { from: string; to: string }
): Promise<FleetUsageExport> {
  const scope = FleetUsageExportScopeSchema.parse(scopeInput);
  const { from, to } = FleetUsageExportQuerySchema.parse(query);
  const start = Date.parse(from);
  const end = Date.parse(to) + FLEET_USAGE_DAY_MS;
  const days: FleetUsageExport['days'] = [];
  for (let time = start; time < end; time += FLEET_USAGE_DAY_MS) {
    days.push({ date: new Date(time).toISOString().slice(0, 10), rows: [] });
  }
  const groups = new Map<string, { date: string; row: FleetUsageExportRow }>();
  // Both predicates constrain the database read, not just the returned payload.
  const cursor = UsageEvent.find({
    userId: { $in: scope.userIds },
    $or: scope.owners.map(owner => ({ ownerId: owner.ownerId, ownerType: owner.ownerType })),
    createdAt: { $gte: new Date(start), $lt: new Date(end) },
  })
    .select(
      'userId ownerId ownerType provider model source settledBasis status inputTokens outputTokens providerInputTokens providerOutputTokens cachedInputTokens cacheWriteTokens costUsd creditsCharged writtenOffCredits createdAt'
    )
    .sort({ createdAt: 1, _id: 1 })
    .maxTimeMS(15_000)
    .lean()
    .cursor();
  let events = 0;
  try {
    for await (const event of cursor) {
      if (++events > 100_000)
        throw new FleetUsageExportTooLargeError('Snapshot event limit exceeded; request fewer days');
      const date = event.createdAt.toISOString().slice(0, 10);
      const row = FleetUsageExportRowSchema.parse({
        userId: event.userId,
        email: null,
        ownerId: event.ownerId,
        ownerType: event.ownerType,
        provider: event.provider,
        model: event.model,
        source: event.source ?? 'unclassified',
        settledBasis: event.settledBasis ?? 'unclassified',
        status: event.status,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        providerInputTokens: event.providerInputTokens ?? null,
        providerOutputTokens: event.providerOutputTokens ?? null,
        cacheReadTokens: event.cachedInputTokens,
        cacheWriteTokens: event.cacheWriteTokens,
        costUsd: event.costUsd,
        creditsCharged: event.creditsCharged,
        writtenOffCredits: event.writtenOffCredits ?? 0,
        requests: 1,
      });
      const key = JSON.stringify([
        date,
        row.userId,
        row.ownerId,
        row.ownerType,
        row.provider,
        row.model,
        row.settledBasis,
        row.source,
        row.status,
      ]);
      const existing = groups.get(key);
      if (!existing) {
        if (groups.size >= FLEET_USAGE_MAX_ROWS)
          throw new FleetUsageExportTooLargeError('Snapshot row limit exceeded; request fewer days');
        groups.set(key, { date, row });
      } else {
        for (const field of sumFields) existing.row[field] += row[field];
        // A partial provider sum is not a known total. Keep each axis unknown independently.
        for (const field of ['providerInputTokens', 'providerOutputTokens'] as const) {
          const previous = existing.row[field];
          const next = row[field];
          existing.row[field] = previous === null || next === null ? null : previous + next;
        }
      }
    }
  } finally {
    await cursor.close();
  }
  const actorIds = [...new Set([...groups.values()].map(({ row }) => row.userId))];
  const accounts = await User.find({ _id: { $in: actorIds.filter(id => /^[a-f\d]{24}$/i.test(id)) } })
    .select('_id email')
    .lean();
  // Account emails are unvalidated free text; one malformed address must not fail the whole pull.
  const emails = new Map(
    accounts.map(account => [
      String(account._id),
      FleetUsageExportRowSchema.shape.email.safeParse(account.email).data ?? null,
    ])
  );
  for (const [, { date, row }] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    row.email = emails.get(row.userId) ?? null;
    days[(Date.parse(date) - start) / FLEET_USAGE_DAY_MS].rows.push(row);
  }
  return FleetUsageExportSchema.parse({ version: 1, from, to, generatedAt: new Date().toISOString(), days });
}
