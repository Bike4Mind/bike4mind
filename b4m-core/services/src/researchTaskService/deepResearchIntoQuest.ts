import { isTerminalCreditRefusal } from '@bike4mind/common';
import { performDeepResearch } from '../llm/tools/implementation/deepResearch';
import type { ToolContext } from '../llm/tools/base/types';

export const DEEP_RESEARCH_HEARTBEAT_MS = 30_000;
export const DEEP_RESEARCH_PROGRESS_MIN_GAP_MS = 2_000;
export const DEEP_RESEARCH_INTO_QUEST_MAX_DEPTH = 4;
export const DEEP_RESEARCH_DEADLINE_MS = 11 * 60_000;
export const DEEP_RESEARCH_FAILED_REPLY = 'Deep research could not finish. Try again in a minute.';

export interface DeepResearchIntoQuestAdapters {
  quests: {
    findById(id: string): Promise<{ id: string; sessionId: string; status?: string } | null>;
    updateIfUnfinished(data: { id: string } & Record<string, unknown>): Promise<unknown>;
    settleIfUnfinished(
      id: string,
      patch: { status: 'done'; type?: 'error'; reply: string; replies: string[] }
    ): Promise<boolean>;
  };
  toolContext: Omit<ToolContext, 'statusUpdate' | 'llm'>;
  llm: Pick<ToolContext['llm'], 'complete'> & { currentModel: string };
  logger: { info(...a: unknown[]): void; warn(...a: unknown[]): void; error(...a: unknown[]): void };
  research?: typeof performDeepResearch;
}

type ResearchState = { findings: unknown[]; completed: boolean } & Record<string, unknown>;

/**
 * Deep research run outside a chat turn, reported into an existing running quest.
 * The quest must keep moving: the stuck-quest sweep settles a running quest whose updatedAt
 * is older than QUEST_TIMEOUT_THRESHOLD_MS (server-utils questTimeoutRecovery).
 */
export async function deepResearchIntoQuest(
  params: { questId: string; topic: string },
  adapters: DeepResearchIntoQuestAdapters
): Promise<void> {
  const { questId, topic } = params;
  const { quests, logger } = adapters;
  const quest = await quests.findById(questId);
  if (!quest || quest.status !== 'running') {
    logger.info('deepResearchIntoQuest: quest not running, skipping', { questId, status: quest?.status });
    return;
  }

  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), DEEP_RESEARCH_DEADLINE_MS);
  // Set when the quest was settled elsewhere (stuck-quest sweep or a stop): stop spending, write nothing.
  let settledElsewhere = false;
  const heartbeat = setInterval(() => {
    quests.updateIfUnfinished({ id: questId, updatedAt: new Date() }).then(
      updated => {
        if (updated !== null) return;
        settledElsewhere = true;
        controller.abort();
      },
      err => logger.warn('deepResearchIntoQuest: heartbeat failed', err)
    );
  }, DEEP_RESEARCH_HEARTBEAT_MS);

  let lastProgressAt = 0;
  let lastState = null as ResearchState | null;
  const writeProgress = async (next: ResearchState, force = false) => {
    // Findings stay off the quest: fanout carries the whole document.
    lastState = { ...next, findings: [] };
    const now = Date.now();
    if (!force && now - lastProgressAt < DEEP_RESEARCH_PROGRESS_MIN_GAP_MS) return;
    lastProgressAt = now;
    await quests.updateIfUnfinished({ id: questId, deepResearchState: lastState, updatedAt: new Date() });
  };

  const settle = async (patch: { status: 'done'; type?: 'error'; reply: string; replies: string[] }) => {
    if (settledElsewhere) return;
    await quests.settleIfUnfinished(questId, patch);
  };

  const settleFailed = (reply = DEEP_RESEARCH_FAILED_REPLY) =>
    settle({ status: 'done', type: 'error', reply, replies: [reply] });

  try {
    const research = adapters.research ?? performDeepResearch;
    const context = {
      ...adapters.toolContext,
      llm: adapters.llm,
      getAbortSignal: () => controller.signal,
      statusUpdate: async (update: { deepResearchState?: ResearchState }) => {
        if (!update.deepResearchState) return;
        await writeProgress(update.deepResearchState).catch(err =>
          logger.warn('deepResearchIntoQuest: progress write failed', err)
        );
      },
    } as ToolContext;
    const result = await research(
      context,
      { topic },
      // No apiKeys: they would swap the metered backend for a raw provider client.
      { maxDepth: DEEP_RESEARCH_INTO_QUEST_MAX_DEPTH, model: adapters.llm.currentModel }
    );
    if (!result.success || controller.signal.aborted) {
      logger.warn('deepResearchIntoQuest: research failed', { questId, error: result.error });
      await settleFailed();
      return;
    }

    let report = '';
    await adapters.llm.complete(
      adapters.llm.currentModel,
      [{ role: 'user', content: result.data.finalAnalysisPrompt }],
      { stream: false, temperature: 0.3, abortSignal: controller.signal },
      async chunks => {
        report += chunks.filter(Boolean).join('');
      }
    );
    if (!report.trim()) {
      logger.warn('deepResearchIntoQuest: empty report', { questId });
      await settleFailed();
      return;
    }
    if (lastState) {
      await writeProgress({ ...lastState, completed: true }, true).catch(err =>
        logger.warn('deepResearchIntoQuest: final progress write failed', err)
      );
    }
    await settle({ status: 'done', reply: report, replies: [report] });
  } catch (err) {
    logger.error('deepResearchIntoQuest: failed', { questId, err });
    await settleFailed(isTerminalCreditRefusal(err) && err instanceof Error ? err.message : undefined);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(deadline);
  }
}
