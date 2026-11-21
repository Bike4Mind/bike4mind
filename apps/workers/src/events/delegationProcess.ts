import { withEventContext } from '@workers/utils/eventContext';
import { HTTPError, HttpStatus } from '@bike4mind/common';
import { DelegationEvents } from '@bike4mind/server-utils/utils/eventBus';
import {
  delegatedItemRepository,
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
import { buildDelegationPrompt, parseDelegationReply, type DelegationContent } from './delegationProcess.prompt';

/**
 * `delegation.process` consumer: the assistant's work on one delegated item (POST /api/v1/delegations creates
 * the `pending` row and publishes the event). One pass of the operations model over the intent and the shared
 * content, mirroring email triage; there is no tool loop, so nothing is sent or changed on the user's behalf.
 * The outcome waits for the next brief (apps/workers/src/events/briefCompose.ts).
 *
 * Failures settle the row as `failed` and are not rethrown, except content that is still being extracted:
 * that one throws so the async invoke retries, until the item is old enough to go ahead without it.
 */

const CONTENT_WAIT_MS = 90 * 1000; // Async Lambda retries land ~1 and ~3 minutes in, so the last one proceeds.
const PAGE_CHARS = 12_000;
const FILE_CHARS = 8_000;
const FILE_CHUNKS = 40;
const MODEL_MAX_TOKENS = 800;
const FETCH_TIMEOUT_MS = 60_000;
// The Lambda timeout (infra/eventBus.ts): a run that timed out has let go by the time its retry lands.
const CLAIM_LEASE_MS = 3 * 60 * 1000;

type LogLike = Pick<Logger, 'info' | 'warn' | 'error'>;

/** A 4xx so withEventContext logs this designed retry at warn, not as an error the log monitor alerts on. */
export class ContentNotReadyError extends HTTPError {
  constructor(delegationId: string) {
    super(HttpStatus.Conflict, `Shared files of delegation ${delegationId} are still being extracted`);
    this.name = 'ContentNotReadyError';
  }
}

export type DelegationProcessDeps = {
  now: () => Date;
  items: Pick<typeof delegatedItemRepository, 'findById' | 'claim' | 'releaseClaim' | 'markSettled' | 'markFailed'>;
  /** Whether the call may run: 'ok', or why not (AI access held, or the balance cannot cover it). */
  canRun(userId: string): Promise<'ok' | 'ai_access_held' | 'insufficient_credits'>;
  /** The page's text, billed to the user like their own web fetch. */
  fetchPage(userId: string, url: string): Promise<string>;
  /** The owner's live file, or null. */
  findFile(
    id: string,
    userId: string
  ): Promise<{ fileName: string; mimeType?: string; moderationStatus?: string } | null>;
  /** Extracted text of the file; empty until extraction has run. */
  fileText(id: string): Promise<string>;
  complete(userId: string, delegationId: string, prompt: string): Promise<{ reply: string; model: string }>;
  logger: LogLike;
};

const clip = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max)}\n[truncated]` : text);

async function readPage(deps: DelegationProcessDeps, item: IDelegatedItem): Promise<string | null> {
  if (!item.url) return null;
  try {
    return clip(await deps.fetchPage(item.userId, item.url), PAGE_CHARS);
  } catch (error) {
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

async function loadContent(deps: DelegationProcessDeps, item: IDelegatedItem): Promise<DelegationContent> {
  const waiting = deps.now().getTime() - item.createdAt.getTime() < CONTENT_WAIT_MS;
  const files = [];
  for (const id of item.fileIds) files.push(await readFile(deps, item, id, waiting));
  return { url: item.url, page: await readPage(deps, item), text: item.text, files };
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
  // EventBridge can deliver twice at once; without the lease both would run, and bill, the same work.
  if (!(await items.claim(input.delegationId, deps.now(), CLAIM_LEASE_MS))) {
    logger.info('[Delegation] another delivery holds the item; skipping', { delegationId: input.delegationId });
    return;
  }

  try {
    await settleClaimed(deps, input.delegationId, item);
  } catch (error) {
    // Hand the lease back before the retry lands, or that retry would skip the item as held by another delivery.
    await items.releaseClaim(input.delegationId).catch((releaseError: unknown) => {
      logger.error('[Delegation] could not release the claim', { delegationId: input.delegationId, releaseError });
    });
    throw error;
  }
}

async function settleClaimed(deps: DelegationProcessDeps, delegationId: string, item: IDelegatedItem): Promise<void> {
  const { items, logger } = deps;
  const gate = await deps.canRun(item.userId);
  if (gate !== 'ok') {
    await items.markFailed(delegationId, gate, deps.now());
    return;
  }

  try {
    const content = await loadContent(deps, item);
    const { reply, model } = await deps.complete(
      item.userId,
      delegationId,
      buildDelegationPrompt(item.intent, content)
    );
    const outcome = parseDelegationReply(reply);
    await items.markSettled(delegationId, { ...outcome, model }, deps.now());
    logger.info('[Delegation] item settled', { delegationId, status: outcome.status });
  } catch (error) {
    if (error instanceof ContentNotReadyError) throw error;
    logger.error('[Delegation] processing failed', { delegationId, error });
    await items.markFailed(delegationId, 'processing_failed', deps.now());
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
      fetchPage: async (userId, url) => {
        const user = await userRepository.findById(userId);
        if (!user) throw new Error('No such user');
        const result = await billedWebFetch(
          { caller: { user, logger }, source: 'system' },
          { url, maxTimeoutMs: FETCH_TIMEOUT_MS }
        );
        return result.title ? `# ${result.title}\n\n${webFetchBody(result)}` : webFetchBody(result);
      },
      findFile: (id, userId) => fabFileRepository.findByIdAndUserId(id, userId),
      fileText: async id => {
        const chunks = await fabFileChunkRepository.findTextsByFabFileId(id, { limit: FILE_CHUNKS });
        return chunks.map(chunk => chunk.text).join('\n');
      },
      complete: async (userId, delegationId, prompt) => {
        const startTime = Date.now();
        const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel({ endUserId: userId });
        let reply = '';
        let completionInfo: CompletionInfo | undefined;
        await llm.complete(
          modelId,
          [{ role: 'user', content: prompt }],
          { maxTokens: MODEL_MAX_TOKENS },
          async (chunks: (string | null | undefined)[], info?: CompletionInfo) => {
            reply += chunks.filter(Boolean).join('');
            if (info) completionInfo = info;
          }
        );
        // The delegation id stands in for the session id: the item belongs to no notebook, and the id keys the receipt.
        await recordSessionOperationalUsage({
          userId,
          sessionId: delegationId,
          operation: 'delegated_item',
          modelId,
          modelInfo,
          completionInfo,
          startTime,
          logger,
        });
        return { reply, model: modelId };
      },
      logger,
    },
    input
  );
});
