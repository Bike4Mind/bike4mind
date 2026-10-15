/**
 * The `music_generation` tool config for agent-mode runs (the parent and its in-process subagents).
 *
 * Same base config as chat (questProcessor.getMusicToolConfigResolver) and the same exclusions as
 * agentExecutor.videoToolConfig.ts, but no per-run cap yet: the synchronous tool this replaced had
 * none either. Music jobs hold and settle their own credits, so nothing here touches
 * agentExecutor.billing.ts.
 */
import type { MusicToolConfig } from '@bike4mind/services/llm/tools';
import type { Logger } from '@bike4mind/observability';
import { getCreateMusicJobDeps, getMusicJobDeps } from '@server/generationJobs/wiring';
import { buildMusicToolConfig } from '@server/musicGenerations/buildMusicToolConfig';

export type AgentMusicToolConfigDeps = {
  buildBaseConfig(userId: string): Promise<MusicToolConfig | null>;
  logger: Logger;
};

export type BuildAgentMusicToolConfigInput = {
  userId: string;
  /** Set when an API key started the run; such runs never get the tool. */
  apiKeyId?: string;
  /** The run's real Quest id (resolveExecutionQuestId); the song card attaches to it. */
  questId?: string;
  /** Whether the run's toolbelt names music_generation; skips the settings and key reads otherwise. */
  toolEnabled: boolean;
};

/**
 * Null means the tool is not offered: not in the toolbelt, an API-key run (same exclusion as chat), no
 * Quest to attach the song card to, no usable music model, or a failed read (fail closed).
 */
export async function buildAgentMusicToolConfig(
  { userId, apiKeyId, questId, toolEnabled }: BuildAgentMusicToolConfigInput,
  deps: AgentMusicToolConfigDeps
): Promise<MusicToolConfig | null> {
  if (!toolEnabled || apiKeyId || !questId) return null;
  try {
    return await deps.buildBaseConfig(userId);
  } catch (error) {
    deps.logger.warn('[AgentMusic] could not build the music tool config; tool not offered this invocation', {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export function getAgentMusicToolConfigDeps(logger: Logger): AgentMusicToolConfigDeps {
  return {
    buildBaseConfig: userId =>
      buildMusicToolConfig(userId, { availability: getMusicJobDeps(), createDeps: getCreateMusicJobDeps() }),
    logger,
  };
}
