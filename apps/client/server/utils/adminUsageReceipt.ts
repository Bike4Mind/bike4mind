import { Types } from 'mongoose';
import {
  CreditHolderType,
  signedCredits,
  type AdminUsageReceipt,
  type AdminUsageReceiptCall,
  type CreditTransactionType,
  type IUsageEventRequestMeta,
} from '@bike4mind/common';
import { CreditTransaction, UsageEvent } from '@bike4mind/database';
import { userApiKeyRepository } from '@bike4mind/database/auth';
import { pairWriteOffs } from './ledgerWriteOffs';

/**
 * Builds the admin usage receipt (adminUsageReceiptSchema) from UsageEvent and ledger rows. Both reads
 * project an explicit field list, so message text, file names and titles are never even loaded.
 */

const QUERY_MAX_TIME_MS = 15_000;
/** A request's calls and ledger rows land within this of the charge an admin clicked. */
const LOOKUP_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_CALLS = 200;

export type ReceiptEventRow = {
  _id: Types.ObjectId;
  requestId: string;
  createdAt: Date;
  feature: AdminUsageReceiptCall['feature'];
  model: string;
  executedModel?: string;
  source?: AdminUsageReceiptCall['source'];
  apiKeyId?: string;
  status?: AdminUsageReceiptCall['status'];
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  providerInputTokens?: number;
  providerOutputTokens?: number;
  settledBasis?: 'provider' | 'local';
  costUsd: number;
  creditsCharged: number;
  writtenOffCredits?: number;
  reservedCredits?: number;
  requestMeta?: IUsageEventRequestMeta;
};

export type ReceiptLedgerRow = {
  _id: Types.ObjectId;
  type: CreditTransactionType;
  credits: number;
  createdAt: Date;
  questId?: string;
};

const RECEIPT_EVENT_FIELDS = [
  'requestId',
  'createdAt',
  'feature',
  'model',
  'executedModel',
  'source',
  'apiKeyId',
  'status',
  'latencyMs',
  'inputTokens',
  'outputTokens',
  'cachedInputTokens',
  'cacheWriteTokens',
  'providerInputTokens',
  'providerOutputTokens',
  'settledBasis',
  'costUsd',
  'creditsCharged',
  'writtenOffCredits',
  'reservedCredits',
  'requestMeta',
].join(' ');

const count = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

export const receiptCall = (
  event: ReceiptEventRow,
  apiKeyPrefixes: ReadonlyMap<string, string>
): AdminUsageReceiptCall => {
  const meta = event.requestMeta;
  const cost = count(event.creditsCharged);
  const writtenOff = Math.min(count(event.writtenOffCredits), cost);
  const visibleOutput = count(event.outputTokens);
  const providerOutput = event.providerOutputTokens;
  return {
    id: event._id.toHexString(),
    at: event.createdAt.toISOString(),
    feature: event.feature,
    operation: meta?.operation,
    model: event.model,
    executedModel: event.executedModel && event.executedModel !== event.model ? event.executedModel : undefined,
    source: event.source,
    apiKeyPrefix: event.apiKeyId ? apiKeyPrefixes.get(event.apiKeyId) : undefined,
    status: event.status ?? 'ok',
    stopReason: meta?.stopReason,
    latencyMs: event.latencyMs,
    tokens: {
      input: event.providerInputTokens ?? count(event.inputTokens),
      cacheRead: count(event.cachedInputTokens),
      cacheWrite: count(event.cacheWriteTokens),
      output: providerOutput ?? visibleOutput,
      visibleOutput,
      thinking: providerOutput !== undefined ? Math.max(0, providerOutput - visibleOutput) : undefined,
      basis: event.settledBasis,
    },
    credits: { cost, charged: cost - writtenOff, writtenOff, reserved: event.reservedCredits },
    costUsd: event.costUsd,
    limits: {
      maxOutputTokens: meta?.maxOutputTokens,
      capBound: meta?.creditCapOutputTokens !== undefined || meta?.stoppedForCredits === true || writtenOff > 0,
      creditCapOutputTokens: meta?.creditCapOutputTokens,
      stoppedForCredits: meta?.stoppedForCredits === true,
      reasoningEffort: meta?.reasoningEffort,
      thinkingBudgetTokens: meta?.thinkingBudgetTokens,
    },
    toolCalls: (meta?.toolCalls ?? []).map(({ name, count: calls }) => ({ name, count: calls })),
    attachments: { count: count(meta?.attachmentCount), totalBytes: count(meta?.attachmentBytes) },
    detailRecorded: meta !== undefined,
  };
};

export const buildUsageReceipt = (
  requestId: string,
  events: readonly ReceiptEventRow[],
  ledgerRows: readonly ReceiptLedgerRow[],
  apiKeyPrefixes: ReadonlyMap<string, string>
): AdminUsageReceipt => {
  const calls = events.map(event => receiptCall(event, apiKeyPrefixes));
  const writeOffs = new Map(
    pairWriteOffs(
      events
        .filter(event => event.feature === 'chat' && count(event.writtenOffCredits) > 0)
        .map(event => ({
          requestId: event.requestId,
          creditsCharged: event.creditsCharged,
          writtenOffCredits: count(event.writtenOffCredits),
          createdAt: event.createdAt,
        })),
      ledgerRows.filter(row => row.type === 'text_generation_usage')
    ).map(writeOff => [writeOff.transactionId, writeOff.writtenOffCredits])
  );
  const totals = calls.reduce(
    (sum, call) => ({
      cost: sum.cost + call.credits.cost,
      charged: sum.charged + call.credits.charged,
      writtenOff: sum.writtenOff + call.credits.writtenOff,
    }),
    { cost: 0, charged: 0, writtenOff: 0 }
  );
  return {
    requestId,
    calls,
    ledger: ledgerRows.map(row => {
      const id = row._id.toHexString();
      const writtenOffCredits = writeOffs.get(id);
      return {
        id,
        at: row.createdAt.toISOString(),
        type: row.type,
        credits: signedCredits(row.type, row.credits) + (writtenOffCredits ?? 0),
        writtenOffCredits,
      };
    }),
    totals,
  };
};

/** The receipt for one request of `userId`, read from the day around `at`. */
export async function loadUsageReceipt(userId: string, requestId: string, at: Date): Promise<AdminUsageReceipt> {
  const createdAt = {
    $gte: new Date(at.getTime() - LOOKUP_WINDOW_MS),
    $lte: new Date(at.getTime() + LOOKUP_WINDOW_MS),
  };
  const [events, ledgerRows] = await Promise.all([
    UsageEvent.find({ userId, requestId, createdAt })
      .select(RECEIPT_EVENT_FIELDS)
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_CALLS)
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<ReceiptEventRow[]>(),
    CreditTransaction.find({
      ownerId: userId,
      ownerType: CreditHolderType.User,
      createdAt,
      $or: [{ questId: requestId }, { 'metadata.requestId': requestId }],
    })
      .select('_id type credits createdAt questId')
      .sort({ createdAt: 1, _id: 1 })
      .limit(MAX_CALLS)
      .maxTimeMS(QUERY_MAX_TIME_MS)
      .lean<ReceiptLedgerRow[]>(),
  ]);

  const apiKeyIds = [...new Set(events.map(event => event.apiKeyId).filter((id): id is string => !!id))];
  const keys = await Promise.all(apiKeyIds.map(id => userApiKeyRepository.findById(id)));
  const apiKeyPrefixes = new Map(
    keys.flatMap((key, index) => (key?.keyPrefix ? [[apiKeyIds[index], key.keyPrefix] as const] : []))
  );
  return buildUsageReceipt(requestId, events, ledgerRows, apiKeyPrefixes);
}
