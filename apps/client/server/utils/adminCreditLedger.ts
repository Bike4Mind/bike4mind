import { z } from 'zod';
import {
  BadRequestError,
  CREDIT_TRANSACTION_KIND,
  CreditHolderType,
  signedCredits,
  type AdminLedgerKind,
  type AdminLedgerRow,
  type CreditTransactionType,
} from '@bike4mind/common';
import { creditTransactionRepository, userRepository } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import type { Logger } from '@bike4mind/observability';

/** Where a page continues from: the last row of the previous page in {createdAt, _id} order. */
export type LedgerCursor = { createdAt: Date; id: string };

const OBJECT_ID_PATTERN = /^[0-9a-f]{24}$/i;

const cursorPayloadSchema = z.object({
  c: z.iso.datetime(),
  i: z.string().regex(OBJECT_ID_PATTERN),
});

export const encodeLedgerCursor = ({ createdAt, id }: LedgerCursor): string =>
  Buffer.from(JSON.stringify({ c: createdAt.toISOString(), i: id })).toString('base64url');

/** Cursors are client-held, so a malformed one is a 400 rather than a crash or an empty page. */
export function decodeLedgerCursor(raw: string): LedgerCursor {
  const invalid = () => new BadRequestError('Invalid cursor');
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  const parsed = cursorPayloadSchema.safeParse(payload);
  if (!parsed.success) throw invalid();
  return { createdAt: new Date(parsed.data.c), id: parsed.data.i };
}

type LedgerDocument = Awaited<ReturnType<typeof creditTransactionRepository.findLedgerPage>>[number];

const asString = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

type Lookups = { actorNames: Map<string, string>; apiKeyPrefixes: Map<string, string> };

const distinct = (values: Array<string | undefined>): string[] => [
  ...new Set(values.filter((value): value is string => !!value && OBJECT_ID_PATTERN.test(value))),
];

/** Each distinct actor and API key is looked up once; only the key prefix is read, never a hash. */
async function loadLookups(documents: LedgerDocument[]): Promise<Lookups> {
  const records = documents.map(doc => doc as unknown as Record<string, unknown>);
  const actorIds = distinct(
    records.map(record => asString((record.metadata as Record<string, unknown> | undefined)?.actorId))
  );
  const apiKeyIds = distinct(records.map(record => asString(record.apiKeyId)));
  const lookups: Lookups = { actorNames: new Map(), apiKeyPrefixes: new Map() };

  await Promise.all([
    ...actorIds.map(async id => {
      const actor = await userRepository.findById(id);
      if (actor) lookups.actorNames.set(id, actor.name || actor.email || actor.username || id);
    }),
    ...apiKeyIds.map(async id => {
      const key = await userApiKeyRepository.findById(id);
      if (key?.keyPrefix) lookups.apiKeyPrefixes.set(id, key.keyPrefix);
    }),
  ]);
  return lookups;
}

type BuildRowsOptions = {
  /** The active kind filter; filtered pages are not contiguous, so no running balance is derived. */
  kind: AdminLedgerKind | undefined;
  /** Balance right after the first document; required when `kind` is undefined. */
  balanceAfterFirst?: number;
  /** Where a derived balance that disagrees with an adjustment's recorded one is reported. */
  userId?: string;
  logger?: Logger;
};

/** Maps ledger documents to the wire rows (see adminLedgerRowSchema). */
export async function buildLedgerRows(
  documents: LedgerDocument[],
  { kind: filterKind, balanceAfterFirst, userId, logger }: BuildRowsOptions
): Promise<AdminLedgerRow[]> {
  const lookups = await loadLookups(documents);
  let runningBalance = filterKind === undefined ? balanceAfterFirst : undefined;

  return documents.map(doc => {
    const record = doc as unknown as Record<string, unknown>;
    const metadata = (record.metadata ?? {}) as Record<string, unknown>;
    const type = doc.type as CreditTransactionType;
    const kind = CREDIT_TRANSACTION_KIND[type];
    const credits = signedCredits(type, doc.credits);
    const actorId = asString(metadata.actorId);
    const apiKeyId = asString(record.apiKeyId);

    let balanceAfter: number | undefined;
    if (runningBalance !== undefined) {
      balanceAfter = runningBalance;
      runningBalance -= credits;
      // The derivation assumes currentCredits equals the sum of this owner's ledger rows. The recorded
      // balance is itself best-effort (see adminUpdate.ts), so a mismatch is reported, not corrected.
      const recorded = kind === 'adjustment' ? asNumber(metadata.resultingBalance) : undefined;
      if (recorded !== undefined && recorded !== balanceAfter) {
        logger?.warn('[ADMIN_LEDGER_BALANCE_DRIFT]', {
          userId,
          transactionId: doc.id,
          derived: balanceAfter,
          recorded,
        });
      }
    } else if (kind === 'adjustment') {
      balanceAfter = asNumber(metadata.resultingBalance);
    }

    return {
      id: doc.id,
      type,
      kind,
      createdAt: doc.createdAt.toISOString(),
      credits,
      balanceAfter,
      model: asString(record.model),
      source: asString(record.source),
      apiKeyId,
      apiKeyPrefix: apiKeyId ? lookups.apiKeyPrefixes.get(apiKeyId) : undefined,
      inputTokens: asNumber(record.inputTokens),
      outputTokens: asNumber(record.outputTokens),
      description: asString(record.description),
      reason: asString(record.reason),
      note: asString(metadata.note),
      actorId,
      actorName: actorId ? lookups.actorNames.get(actorId) : undefined,
    };
  });
}

/**
 * Balance right after the first row of a page. The first page starts at the current balance; a later
 * page subtracts what every newer row moved it by, in one aggregation.
 */
export async function balanceAfterFirstRow(
  userId: string,
  currentBalance: number,
  first: LedgerDocument,
  isFirstPage: boolean
): Promise<number> {
  if (isFirstPage) return currentBalance;
  const newerNet = await creditTransactionRepository.sumSignedCreditsNewerThan(userId, CreditHolderType.User, {
    createdAt: first.createdAt,
    id: first.id,
  });
  return currentBalance - newerNet;
}
