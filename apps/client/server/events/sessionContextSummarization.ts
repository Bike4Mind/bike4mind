import { withEventContext } from '@server/events/utils';
import { SessionEvents } from '@server/utils/eventBus';
import { Quest, Session, sessionRepository } from '@bike4mind/database';
import { OperationsModelService } from '@client/services/operationsModelService';
import { ChatModelName, IMessage, MessageContentObject } from '@bike4mind/common';
import type { CompletionInfo } from '@bike4mind/llm-adapters';
import { recordSessionOperationalUsage } from '@server/events/recordSessionOperationalUsage';
import mongoose from 'mongoose';

export const handler = withEventContext(async (event, logger) => {
  const body = SessionEvents.ContextSummarize.schema.parse(event.properties);
  const { sessionId, verbatimWindowStartQuestId } = body;

  logger.updateMetadata({ sessionId, verbatimWindowStartQuestId });

  const session = await Session.findById(sessionId);
  if (!session) {
    logger.warn(`Session not found: ${sessionId}`);
    return;
  }

  // Quests after the last summarized boundary (exclusive) up to verbatimWindowStartQuestId (exclusive)
  const questQuery: Record<string, unknown> = {
    sessionId: session.id,
    deletedAt: null,
    _id: {
      ...(session.contextSummaryUpToQuestId
        ? { $gt: new mongoose.Types.ObjectId(session.contextSummaryUpToQuestId) }
        : {}),
      $lt: new mongoose.Types.ObjectId(verbatimWindowStartQuestId),
    },
  };

  const quests = await Quest.find(questQuery).sort({ timestamp: 1 });

  if (!quests.length) {
    logger.debug(`No quests in summarization window for session ${sessionId}`);
    return;
  }

  logger.info(
    `Context-summarizing session ${sessionId}: ${quests.length} quests (${session.contextSummaryUpToQuestId ?? 'start'} → ${verbatimWindowStartQuestId})`
  );

  const { modelId, llm, modelInfo } = await OperationsModelService.getOperationsModel();

  const questContent = quests
    .map(quest => {
      const lines = [`Q: ${quest.prompt}`];

      // Priority 1: structured replies contain full tool-use context
      if (quest.structuredReplies && quest.structuredReplies.length > 0) {
        const parts: string[] = [];
        for (const structuredReply of quest.structuredReplies) {
          for (const block of structuredReply.content as MessageContentObject[]) {
            if (block.type === 'text' && block.text) {
              parts.push(block.text);
            } else if (block.type === 'tool_use') {
              const input = JSON.stringify(block.input ?? {});
              parts.push(`[tool: ${block.name}(${input})]`);
            }
          }
        }
        if (quest.toolResults && quest.toolResults.length > 0) {
          for (const tr of quest.toolResults) {
            parts.push(`[tool_result: ${tr.content || '(empty)'}${tr.is_error ? ' ERROR' : ''}]`);
          }
        }
        lines.push(`A: ${parts.join('\n') || '(no reply)'}`);
      } else {
        // Priority 2: plain text reply
        lines.push(`A: ${quest.reply || quest.replies?.join('\n') || '(no reply)'}`);
      }

      return lines.join('\n');
    })
    .join('\n\n');

  const systemPromptParts = [
    `You are generating a technical context summary for an AI assistant to use as working memory.
Extract and preserve with maximum fidelity:
- Specific decisions made and why
- Exact code artifacts written (file names, function names, key implementation details)
- Errors encountered and their resolutions
- Established facts (URLs, paths, configuration values, constraints the user has stated)
- Active tasks and their current status

Do NOT include conversational pleasantries or meta-commentary.
Format: Dense bullet points. Preserve all technical specifics. No word limit.`,
  ];

  // Incremental: extend existing summary rather than re-summarizing from scratch
  if (session.contextSummary) {
    systemPromptParts.push(
      `Previously established context (extend this — do not re-summarize):\n${session.contextSummary}`
    );
  }

  const messages: IMessage[] = [
    { role: 'system', content: systemPromptParts.join('\n\n---\n\n') },
    { role: 'user', content: questContent },
  ];

  const completionBuffers: string[] = [];
  let lastCompletionInfo: CompletionInfo | undefined;
  const completionStartTime = Date.now();

  await llm.complete(
    modelId,
    messages,
    { stream: false },
    async (chunk: unknown[], completionInfo?: CompletionInfo) => {
      chunk.forEach((part: unknown, index: number) => {
        if (part === undefined || part === null) return;
        completionBuffers[index] = (completionBuffers[index] ?? '') + String(part);
      });
      if (completionInfo) lastCompletionInfo = completionInfo;
    }
  );

  // The context-summarize event carries no userId; attribute to the session's owner.
  await recordSessionOperationalUsage({
    userId: session.userId,
    sessionId,
    modelId,
    modelInfo,
    completionInfo: lastCompletionInfo,
    startTime: completionStartTime,
    logger,
  });

  const contextSummaryText = completionBuffers
    .map(text => text?.trim())
    .filter((text): text is string => Boolean(text))
    .join('\n');

  if (!contextSummaryText) {
    logger.warn(`Empty context summary generated for session ${sessionId}`);
    return;
  }

  // The new boundary is the ID of the last quest we included in this summary
  const newBoundaryQuestId = quests[quests.length - 1].id;

  await sessionRepository.update({
    id: session.id,
    contextSummary: contextSummaryText,
    contextSummaryUpToQuestId: newBoundaryQuestId,
    contextSummaryAt: new Date(),
    contextSummaryModelId: modelId as ChatModelName,
  });

  logger.info(`Context summary updated for session ${sessionId} (boundary: ${newBoundaryQuestId})`);
});
