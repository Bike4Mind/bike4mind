import mongoose from 'mongoose';
import { insufficientCreditsError, type AccessContext, type ObligationHandoffRequest } from '@bike4mind/common';
import { dataLakeService } from '@bike4mind/services';
import {
  adminSettingsRepository,
  dataLakeAccessGrantRepository,
  dataLakeRepository,
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
import { isFeatureEnabled } from '@bike4mind/server-utils/middlewares/featureFlag';
import { OperationsModelService } from '@bike4mind/server-utils/services/operationsModelService';
import { recordSessionOperationalUsage } from '@bike4mind/server-utils/billing/recordSessionOperationalUsage';
import { payerCanFundSessionOperation } from '@bike4mind/server-utils/billing/sessionOperationalCreditGate';
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
  /** Lakes the user can file into: manageable and not built in. */
  listLakes(): Promise<ObligationLake[]>;
  canFund(userId: string): Promise<boolean>;
  complete(
    userId: string,
    prompt: string
  ): Promise<{ reply: string; model: string; recordUsage(sessionId: string): Promise<void> }>;
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
  const existing = await deps.obligations.findByFileForUser(body.file_id, userId);
  if (existing) return { obligation: existing, created: false };

  const file = mongoose.isValidObjectId(body.file_id) ? await deps.findFile(body.file_id, userId) : null;
  if (!file) throw new NotFoundError('File not found');
  if (file.moderationStatus === 'pending' || file.moderationStatus === 'scanning') {
    throw new ConflictError('The file is still being checked; retry shortly');
  }
  if (file.moderationStatus === 'blocked') {
    throw new UnprocessableEntityError('This file cannot be processed');
  }

  const text = body.text?.trim() || (await deps.fileText(body.file_id)).trim();
  if (!text) throw new UnprocessableEntityError('There is nothing readable in this document');

  const lakes = await deps.listLakes();
  if (!(await deps.canFund(userId))) {
    throw insufficientCreditsError('Not enough credits to read this document');
  }

  const { reply, model, recordUsage } = await deps.complete(userId, buildExtractionPrompt(text, lakes));
  let extraction;
  try {
    extraction = parseExtraction(reply, lakes);
  } catch (error) {
    if (!(error instanceof ObligationExtractionParseError)) throw error;
    deps.logger.warn('[obligations] model reply was not JSON; nothing stored', { fileId: body.file_id });
    throw new BadGatewayError('The assistant could not read this document; try again');
  }

  // Pre-generated so the receipt is keyed to the row it paid for.
  const id = new mongoose.Types.ObjectId();
  const result = await deps.obligations.create({
    _id: id,
    userId,
    fileId: body.file_id,
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
  // The model call ran either way, so the loser of a concurrent hand-off race is charged too.
  await recordUsage(id.toString());
  return result;
}

/** Production wiring for the route; `ctx` is the caller's member access context. */
export function createHandOffDeps(ctx: AccessContext, logger: Logger): HandOffDeps {
  return {
    obligations: obligationRepository,
    findFile: (fileId, userId) => fabFileRepository.findByIdAndUserId(fileId, userId),
    fileText: async fileId => {
      const chunks = await fabFileChunkRepository.findTextsByFabFileId(fileId, { limit: FILE_CHUNKS });
      return chunks.map(chunk => chunk.text).join('\n');
    },
    listLakes: async () => {
      if (!(await isFeatureEnabled('EnableDataLakes'))) return [];
      const lakes = await dataLakeService.listDataLakes(ctx, {
        db: {
          dataLakes: dataLakeRepository,
          dataLakeAccessGrants: dataLakeAccessGrantRepository,
          settings: adminSettingsRepository,
        },
      });
      return lakes
        .filter(lake => lake.canManage === true && !dataLakeService.isFallbackLake(lake))
        .map(lake => ({ id: lake.id, name: lake.name }));
    },
    canFund: userId => payerCanFundSessionOperation({ payerId: userId, operation: 'scanned document', logger }),
    complete: async (userId, prompt) => {
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
      // The obligation id stands in for the session id: the scan belongs to no notebook.
      const recordUsage = (sessionId: string) =>
        recordSessionOperationalUsage({
          userId,
          sessionId,
          operation: 'document_obligation',
          modelId,
          modelInfo,
          completionInfo,
          startTime,
          logger,
        });
      return { reply, model: modelId, recordUsage };
    },
    logger,
  };
}
