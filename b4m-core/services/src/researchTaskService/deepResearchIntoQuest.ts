import { performDeepResearch } from '../llm/tools/implementation/deepResearch';
import type { ToolContext } from '../llm/tools/base/types';

export const DEEP_RESEARCH_HEARTBEAT_MS = 30_000;
export const DEEP_RESEARCH_PROGRESS_MIN_GAP_MS = 2_000;
export const DEEP_RESEARCH_INTO_QUEST_MAX_DEPTH = 4;
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
  /** The chat path's WS status push; a running quest the client did not start still needs it. */
  push(quest: { id: string; sessionId: string } & Record<string, unknown>): Promise<void>;
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
  const { quests, push, logger } = adapters;
  const quest = await quests.findById(questId);
  if (!quest || quest.status !== 'running') {
    logger.info('deepResearchIntoQuest: quest not running, skipping', { questId, status: quest?.status });
    return;
  }
  const { sessionId } = quest;

  const heartbeat = setInterval(() => {
    void quests.updateIfUnfinished({ id: questId, updatedAt: new Date() }).catch(err => {
      logger.warn('deepResearchIntoQuest: heartbeat failed', err);
    });
  }, DEEP_RESEARCH_HEARTBEAT_MS);

  let lastProgressAt = 0;
  let lastState = null as ResearchState | null;
  const writeProgress = async (next: ResearchState, force = false) => {
    // Findings stay off the quest: fanout and the WS push carry the whole document.
    lastState = { ...next, findings: [] };
    const now = Date.now();
    if (!force && now - lastProgressAt < DEEP_RESEARCH_PROGRESS_MIN_GAP_MS) return;
    lastProgressAt = now;
    const patch = { id: questId, deepResearchState: lastState, updatedAt: new Date() };
    await quests.updateIfUnfinished(patch);
    await push({ ...patch, sessionId, status: 'running' });
  };

  const settle = async (patch: { status: 'done'; type?: 'error'; reply: string; replies: string[] }) => {
    const settled = await quests.settleIfUnfinished(questId, patch);
    if (settled) await push({ id: questId, sessionId, ...patch, deepResearchState: lastState ?? undefined });
  };

  const settleFailed = () =>
    settle({ status: 'done', type: 'error', reply: DEEP_RESEARCH_FAILED_REPLY, replies: [DEEP_RESEARCH_FAILED_REPLY] });

  try {
    const research = adapters.research ?? performDeepResearch;
    const context = {
      ...adapters.toolContext,
      llm: adapters.llm,
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
    if (!result.success) {
      logger.warn('deepResearchIntoQuest: research failed', { questId, error: result.error });
      await settleFailed();
      return;
    }

    let report = '';
    await adapters.llm.complete(
      adapters.llm.currentModel,
      [{ role: 'user', content: result.data.finalAnalysisPrompt }],
      { stream: false, temperature: 0.3 },
      async chunks => {
        report += chunks.filter(Boolean).join('');
      }
    );
    if (lastState) await writeProgress({ ...lastState, completed: true }, true);
    await settle({ status: 'done', reply: report, replies: [report] });
  } catch (err) {
    logger.error('deepResearchIntoQuest: failed', { questId, err });
    await settleFailed();
  } finally {
    clearInterval(heartbeat);
  }
}
