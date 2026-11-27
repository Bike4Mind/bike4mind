import { randomUUID } from 'node:crypto';
import type { ClientSession } from 'mongoose';
import { withEventContext } from '@workers/utils/eventContext';
import { HTTPError, HttpStatus } from '@bike4mind/common';
import { DelegationEvents } from '@bike4mind/server-utils/utils/eventBus';
import {
  delegatedItemRepository,
  withTransaction,
  fabFileChunkRepository,
  fabFileRepository,
  userRepository,
  type IDelegatedItem,
} from '@bike4mind/database';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { billedWebFetch } from '@bike4mind/server-utils/billing/billedWebTools';
import { webFetchBody } from '@bike4mind/services/llm/tools/implementation/webfetch';
import { aiAccessDeniedMessage } from '@bike4mind/services/userService/accountState';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import { recordSessionOperationalUsage } from '@workers/events/recordSessionOperationalUsage';
import { payerCanFundSessionOperation } from '@workers/events/sessionOperationalCreditGate';
import { DelegationOwnershipLostError, startDelegationLease } from './delegationLease';
import { buildDelegationPrompt, parseDelegationReply, type DelegationContent } from './delegationProcess.prompt';

/**
 * `delegation.process` consumer: the assistant's work on one delegated item (POST /api/v1/delegations creates
 * the `pending` row and publishes the event). One pass of the operations model over the intent and the shared
 * content, mirroring email triage; there is no tool loop, so nothing is sent or changed on the user's behalf.
 * The outcome waits for the next brief (apps/workers/src/events/briefCompose.ts).
 *
 * Failures settle the row as `failed`. Pending busy deliveries, unfinished content and uncertain
 * pre-provider ownership throw so the transport retries; completed provider output is never re-invoked.
 */

const CONTENT_WAIT_MS = 90 * 1000; // Async Lambda retries land ~1 and ~3 minutes in, so the last one proceeds.
const PAGE_CHARS = 12_000;
const FILE_CHARS = 8_000;
const FILE_CHUNKS = 40;
const MODEL_MAX_TOKENS = 800;
const FETCH_TIMEOUT_MS = 60_000;
// Renew during healthy long-running self-host calls; a crashed attempt still expires after three minutes.
const CLAIM_LEASE_MS = 3 * 60 * 1000;

type LogLike = Pick<Logger, 'info' | 'warn' | 'error'>;

/** A 4xx so withEventContext logs this designed retry at warn, not as an error the log monitor alerts on. */
export class ContentNotReadyError extends HTTPError {
  constructor(delegationId: string) {
    super(HttpStatus.Conflict, `Shared files of delegation ${delegationId} are still being extracted`);
    this.name = 'ContentNotReadyError';
  }
}

/** Retain the transport delivery while a pending item still has a processing lease. */
export class DelegationClaimBusyError extends HTTPError {
  constructor(delegationId: string) {
    super(HttpStatus.Conflict, `Delegation ${delegationId} is still being processed`);
    this.name = 'DelegationClaimBusyError';
  }
}

export type DelegationProcessDeps = {
  now: () => Date;
  items: Pick<
    typeof delegatedItemRepository,
    | 'findById'
    | 'claim'
    | 'renewClaim'
    | 'releaseClaim'
    | 'releaseClaimOwned'
    | 'fenceClaim'
    | 'markSettledOwned'
    | 'markFailedOwned'
  >;
  /** Whether the call may run: 'ok', or why not (AI access held, or the balance cannot cover it). */
  canRun(userId: string): Promise<'ok' | 'ai_access_held' | 'insufficient_credits'>;
  /** The page's text, billed to the user like their own web fetch. */
  fetchPage(userId: string, url: string, admit: (session?: ClientSession) => Promise<void>): Promise<string>;
  /** The owner's live file, or null. */
  findFile(
    id: string,
    userId: string
  ): Promise<{ fileName: string; mimeType?: string; moderationStatus?: string } | null>;
  /** Extracted text of the file; empty until extraction has run. */
  fileText(id: string): Promise<string>;
  complete(
    userId: string,
    delegationId: string,
    prompt: string,
    signal: AbortSignal
  ): Promise<{
    reply: string;
    model: string;
    /** Database accounting only, executed after the owned terminal CAS in the same transaction. */
    recordUsage: () => Promise<void>;
  }>;
  logger: LogLike;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);

async function readPage(
  deps: DelegationProcessDeps,
  item: IDelegatedItem,
  admit: (session?: ClientSession) => Promise<void>
): Promise<string | null> {
  if (!item.url) return null;
  try {
    return clip(await deps.fetchPage(item.userId, item.url, admit), PAGE_CHARS);
  } catch (error) {
    if (error instanceof DelegationOwnershipLostError) throw error;
    deps.logger.warn('[Delegation] could not read the shared link', {
      delegationId: item._id.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

async function readFile(deps: DelegationProcessDeps, item: IDelegatedItem, id: string, waiting: boolean) {
  const file = await deps.findFile(id, item.userId);
  if (!file) return { name: id, body: '(this file is no longer available)' };
  const name = file.fileName;
  if (file.moderationStatus === 'blocked') return { name, body: '(withheld by the content scan)' };
  if (file.mimeType?.startsWith('image/')) return { name, body: '(an image; its picture cannot be read here)' };
  const text =
    file.moderationStatus === 'pending' || file.moderationStatus === 'scanning' ? '' : await deps.fileText(id);
  if (text) return { name, body: clip(text, FILE_CHARS) };
  if (waiting) throw new ContentNotReadyError(item._id.toString());
  return { name, body: '(its text was not ready in time)' };
}

async function loadContent(
  deps: DelegationProcessDeps,
  item: IDelegatedItem,
  admit: (session?: ClientSession) => Promise<void>
): Promise<DelegationContent> {
  const waiting = deps.now().getTime() - item.createdAt.getTime() < CONTENT_WAIT_MS;
  const files = [];
  for (const id of item.fileIds) files.push(await readFile(deps, item, id, waiting));
  return { url: item.url, page: await readPage(deps, item, admit), text: item.text, files };
}

export async function processDelegation(
  deps: DelegationProcessDeps,
  input: { delegationId: string; userId: string }
): Promise<void> {
  const { items, logger } = deps;
  const item = await items.findById(input.delegationId);
  if (!item || item.userId !== input.userId) {
    logger.warn('[Delegation] item missing or not owned by the event user; skipping', input);
    return;
  }
  if (item.status !== 'pending') {
    logger.info('[Delegation] item already settled; skipping redelivery', { delegationId: input.delegationId });
    return;
  }
  const token = randomUUID();
  const claimedAt = deps.now();
  if (!(await items.claim(input.delegationId, claimedAt, CLAIM_LEASE_MS, token))) {
    const current = await items.findById(input.delegationId);
    if (!current || current.userId !== input.userId || current.status !== 'pending') return;
    // Returning here consumes the queue event, including a retry of an uncertain renewal.
    throw new DelegationClaimBusyError(input.delegationId);
  }
  const lease = startDelegationLease({
    id: input.delegationId,
    token,
    now: deps.now,
    leaseMs: CLAIM_LEASE_MS,
    expiresAt: new Date(claimedAt.getTime() + CLAIM_LEASE_MS),
    renewEveryMs: 60_000,
    renew: items.renewClaim,
    onLost: error => logger.warn('[Delegation] processing ownership lost', { delegationId: input.delegationId, error }),
  });
  const assertOwner = () => lease.assertActive();
  const admit = async (session?: ClientSession) => {
    try {
      assertOwner();
      if (!(await items.fenceClaim(input.delegationId, token, deps.now(), session))) {
        throw new DelegationOwnershipLostError();
      }
      assertOwner();
    } catch (error) {
      lease.lose(error);
      throw new DelegationOwnershipLostError();
    }
  };
  // A completed provider is never invoked again just because final database persistence failed.
  let providerCompleted = false;
  let failureReason = 'processing_failed';
  let gateChecked = false;
  let completed: Awaited<ReturnType<DelegationProcessDeps['complete']>> | undefined;
  const finalize = async (outcome: ReturnType<typeof parseDelegationReply> | null, reason: string) => {
    await lease.stop();
    assertOwner();
    return withTransaction(async session => {
      assertOwner();
      const changed =
        outcome && completed
          ? await items.markSettledOwned(
              input.delegationId,
              token,
              { ...outcome, model: completed.model },
              deps.now(),
              session
            )
          : await items.markFailedOwned(input.delegationId, token, reason, deps.now(), session);
      if (!changed) throw new DelegationOwnershipLostError();
      // The terminal write above owns the row until commit. No network/provider work occurs here.
      await completed?.recordUsage();
    });
  };
  try {
    const gate = await deps.canRun(item.userId);
    gateChecked = true;
    assertOwner();
    if (gate !== 'ok') {
      failureReason = gate;
      await finalize(null, gate);
      return;
    }
    const content = await loadContent(deps, item, admit);
    assertOwner();
    completed = await deps.complete(
      item.userId,
      input.delegationId,
      buildDelegationPrompt(item.intent, content),
      lease.signal
    );
    providerCompleted = true;
    assertOwner();
    const outcome = parseDelegationReply(completed.reply);
    await finalize(outcome, 'processing_failed');
    logger.info('[Delegation] item settled', { delegationId: input.delegationId, status: outcome.status });
  } catch (error) {
    await lease.stop();
    if (lease.uncertain) {
      if (providerCompleted) {
        logger.error('[Delegation] lease uncertain after completed provider; leaving the item to the stale sweep', {
          delegationId: input.delegationId,
          error: lease.error,
        });
        return;
      }
      // Do not guess the expiry: the renewal may have committed before its acknowledgement failed.
      await items.releaseClaimOwned(input.delegationId, token).catch((releaseError: unknown) => {
        logger.error('[Delegation] could not release uncertain claim; transport must retry', {
          delegationId: input.delegationId,
          releaseError,
        });
      });
      throw lease.error ?? error;
    }
    if (lease.lost || error instanceof DelegationOwnershipLostError) return;
    if (error instanceof ContentNotReadyError || !gateChecked) {
      await items.releaseClaim(input.delegationId, lease.expiresAt, token).catch((releaseError: unknown) => {
        logger.error('[Delegation] could not release the claim', { delegationId: input.delegationId, releaseError });
      });
      throw error;
    }
    logger.error('[Delegation] processing failed', { delegationId: input.delegationId, error });
    try {
      await finalize(null, failureReason);
    } catch (markError) {
      if (markError instanceof DelegationOwnershipLostError || lease.lost) return;
      if (providerCompleted) {
        logger.error('[Delegation] could not record the outcome; leaving the item to the stale sweep', {
          delegationId: input.delegationId,
          markError,
        });
        return;
      }
      await items.releaseClaim(input.delegationId, lease.expiresAt, token).catch((releaseError: unknown) => {
        logger.error('[Delegation] could not release the claim', { delegationId: input.delegationId, releaseError });
      });
      throw markError;
    }
  } finally {
    await lease.stop();
  }
}

export const handler = withEventContext(async (event, logger) => {
  const input = DelegationEvents.Process.schema.parse(event.properties);
  logger.updateMetadata({ delegationId: input.delegationId, userId: input.userId });

  await processDelegation(
    {
      now: () => new Date(),
      items: delegatedItemRepository,
      canRun: async userId => {
        const user = await userRepository.findById(userId);
        if (!user || aiAccessDeniedMessage(user)) return 'ai_access_held';
        const funded = await payerCanFundSessionOperation({ payerId: userId, operation: 'delegated item', logger });
        return funded ? 'ok' : 'insufficient_credits';
      },
      fetchPage: async (userId, url, admit) => {
        const user = await userRepository.findById(userId);
        if (!user) throw new Error('No such user');
        const result = await billedWebFetch(
          { caller: { user, logger }, source: 'system' },
          { url, maxTimeoutMs: FETCH_TIMEOUT_MS, admit }
        );
        return result.title ? `# ${result.title}\n\n${webFetchBody(result)}` : webFetchBody(result);
      },
      findFile: (id, userId) => fabFileRepository.findByIdAndUserId(id, userId),
      fileText: async id => {
        const chunks = await fabFileChunkRepository.findTextsByFabFileId(id, { limit: FILE_CHUNKS });
        return chunks.map(chunk => chunk.text).join('\n');
      },
      complete: async (userId, delegationId, prompt, signal) => {
        const startTime = Date.now();
        const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel({ endUserId: userId });
        if (signal.aborted) throw new DelegationOwnershipLostError();
        let reply = '';
        let completionInfo: CompletionInfo | undefined;
        await llm.complete(
          modelId,
          [{ role: 'user', content: prompt }],
          { maxTokens: MODEL_MAX_TOKENS, abortSignal: signal },
          async (chunks: (string | null | undefined)[], info?: CompletionInfo) => {
            reply += chunks.filter(Boolean).join('');
            if (info) completionInfo = info;
          }
        );
        // The delegation id stands in for the session id: the item belongs to no notebook, and the id keys the receipt.
        const recordUsage = () =>
          recordSessionOperationalUsage({
            userId,
            sessionId: delegationId,
            operation: 'delegated_item',
            modelId,
            modelInfo,
            completionInfo,
            startTime,
            logger,
          });
        return { reply, model: modelId, recordUsage };
      },
      logger,
    },
    input
  );
});
