import mongoose from 'mongoose';
import { insufficientCreditsError, type AccessContext, type ObligationHandoffRequest } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import {
  fabFileChunkRepository,
  fabFileRepository,
  obligationDayToDate,
  obligationRepository,
  type IObligation,
} from '@bike4mind/database';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import type { Logger } from '@bike4mind/observability';
import {
  BadGatewayError,
  ConflictError,
  NotFoundError,
  UnprocessableEntityError,
} from '@bike4mind/server-utils/utils/errors';
import { toObjectIdString } from '@bike4mind/server-utils/utils/objectId';
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { recordSessionOperationalUsage } from '@bike4mind/server-utils/billing/recordSessionOperationalUsage';
import { checkSessionOperationalCredits } from '@bike4mind/server-utils/utils/sessionOperationalCreditPreflight';
import { lakeAccessDb } from '@server/dataLakes/lakeMembershipWrite';
import {
  buildExtractionPrompt,
  parseExtraction,
  ObligationExtractionParseError,
  type ObligationLake,
} from './extractObligation';

const MODEL_MAX_TOKENS = 600;
const FILE_CHUNKS = 40;

type ModerationStatus = 'pending' | 'scanning' | 'clean' | 'blocked';

export type HandOffDeps = {
  obligations: Pick<typeof obligationRepository, 'findByFileForUser' | 'create'>;
  findFile(fileId: string, userId: string): Promise<{ moderationStatus?: ModerationStatus } | null>;
  fileText(fileId: string): Promise<string>;
  /** Lakes the user can file into: manageable and not built in. Empty when the caller may not file into lakes. */
  listLakes(): Promise<ObligationLake[]>;
  /** False when the payer cannot cover the call or is frozen; a billing-read failure fails open. */
  canFund(userId: string): Promise<boolean>;
  /** Runs the model, hands the reply to `store`, then charges under the id it returns; a throwing `store` is not charged. */
  complete<T>(
    userId: string,
    prompt: string,
    store: (reply: string, model: string) => Promise<{ sessionId: string; value: T }>
  ): Promise<T>;
  logger: Logger;
};

export type HandOffResult = { obligation: IObligation; created: boolean };

/**
 * Extracts an obligation from a scanned file the user owns and stores it pending their confirmation.
 * A second hand-off of the same file returns the first row without another model call or charge.
 */
export async function handOffDocument(
  userId: string,
  body: ObligationHandoffRequest,
  deps: HandOffDeps
): Promise<HandOffResult> {
  // Canonical form, so a differently-cased id cannot slip past the duplicate lookup into a second row and charge.
  const fileId = toObjectIdString(body.file_id);
  if (!fileId) throw new NotFoundError('File not found');
  const existing = await deps.obligations.findByFileForUser(fileId, userId);
  if (existing) return { obligation: existing, created: false };

  const file = await deps.findFile(fileId, userId);
  if (!file) throw new NotFoundError('File not found');
  if (file.moderationStatus === 'pending' || file.moderationStatus === 'scanning') {
    throw new ConflictError('The file is still being checked; retry shortly');
  }
  if (file.moderationStatus === 'blocked') {
    throw new UnprocessableEntityError('This file cannot be processed');
  }

  const text = body.text?.trim() || (await deps.fileText(fileId)).trim();
  if (!text) throw new UnprocessableEntityError('There is nothing readable in this document');

  const lakes = await deps.listLakes();
  if (!(await deps.canFund(userId))) {
    throw insufficientCreditsError('Not enough credits to read this document');
  }

  const result = await deps.complete(userId, buildExtractionPrompt(text, lakes), async (reply, model) => {
    // Pre-generated so a stored row's receipt carries its id. An unreadable reply and the loser of a
    // concurrent hand-off race are charged under an id no row has: the model call ran either way.
    const id = new mongoose.Types.ObjectId();
    let extraction;
    try {
      extraction = parseExtraction(reply, lakes);
    } catch (error) {
      if (!(error instanceof ObligationExtractionParseError)) throw error;
      deps.logger.warn('[obligations] model reply was not JSON; nothing stored', { fileId });
      return { sessionId: id.toString(), value: null };
    }
    const stored = await deps.obligations.create({
      _id: id,
      userId,
      fileId,
      documentKind: extraction.documentKind,
      amountValue: extraction.amount?.value ?? null,
      currency: extraction.amount?.currency ?? null,
      payee: extraction.payee,
      dueDate: extraction.dueDate ? obligationDayToDate(extraction.dueDate) : null,
      destinationLakeId: extraction.destination?.id ?? null,
      destinationName: extraction.destination?.name ?? null,
      summary: extraction.summary,
      model,
    });
    return { sessionId: id.toString(), value: stored };
  });
  if (!result) throw new BadGatewayError('The assistant could not read this document; try again');
  return result;
}

/** Production wiring for the route; `ctx` is the caller's member access context. */
export function createHandOffDeps(ctx: AccessContext, logger: Logger, opts: { offerLakes: boolean }): HandOffDeps {
  return {
    obligations: obligationRepository,
    findFile: (fileId, userId) => fabFileRepository.findByIdAndUserId(fileId, userId),
    fileText: async fileId => {
      const chunks = await fabFileChunkRepository.findTextsByFabFileId(fileId, { limit: FILE_CHUNKS });
      return chunks.map(chunk => chunk.text).join('\n');
    },
    listLakes: async () => {
      if (!opts.offerLakes || !(await isFeatureEnabled('EnableDataLakes'))) return [];
      const lakes = await dataLakeService.listDataLakes(ctx, { db: lakeAccessDb });
      return lakes
        .filter(lake => lake.canManage === true && !dataLakeService.isFallbackLake(lake))
        .map(lake => ({ id: lake.id, name: lake.name }));
    },
    canFund: async userId => {
      const verdict = await checkSessionOperationalCredits({
        userId,
        operationCount: 1,
        operation: 'scanned document',
        logger,
      });
      if (verdict.allowed) return true;
      // A spend freeze (403) or the free tier's daily cap (429) is not an empty balance.
      if (verdict.dailyCapError ?? verdict.frozenError) throw verdict.dailyCapError ?? verdict.frozenError;
      return false;
    },
    complete: async (userId, prompt, store) => {
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
      const { sessionId, value } = await store(reply, modelId);
      // The obligation id stands in for the session id: the scan belongs to no notebook.
      await recordSessionOperationalUsage({
        userId,
        sessionId,
        operation: 'document_obligation',
        modelId,
        modelInfo,
        completionInfo,
        startTime,
        logger,
      });
      return value;
    },
    logger,
  };
}
