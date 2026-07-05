import { Resource } from 'sst';
import { buildSharedTools, type ToolBuilderDeps, type ToolBuilderCallbacks } from '@bike4mind/services';
import {
  adminSettingsRepository,
  apiKeyRepository,
  dataLakeRepository,
  fabFileChunkRepository,
  fabFileRepository,
  imageModerationIncidentRepository,
  projectRepository,
  userRepository,
} from '@bike4mind/database';
import { getAvailableModels, type ApiKeyTable, type ICompletionBackend } from '@bike4mind/llm-adapters';
import type { IUserDocument } from '@bike4mind/common';
import type { Logger } from '@bike4mind/observability';
import { getFilesStorage, getGeneratedImageStorage } from '@server/utils/storage';
import type { ToolMaterializer } from '@bike4mind/agents';
import { buildSystemApiKeyTable } from './resolveBackend';

/**
 * Builds the owner-scoped b4m toolbelt for a deep agent's act step.
 *
 * Tools run as the agent's OWNER (charter.identity.ownerUserId) - their
 * storage, billing, and permissions. The agent-execution-specific machinery
 * (DAG dispatch, subagent handoff, websocket status) is intentionally omitted,
 * so `coordinate_task`/`delegate_to_agent` are simply not registered; the deep
 * agent gets the plain toolbelt (e.g. retrieve_knowledge_content, bash_execute,
 * create_file) filtered to its profile's `enabledToolNames`.
 *
 * NOTE: this performs real, side-effecting tool execution under a real user.
 * It is opt-in (wired only when `buildTools` is supplied to buildDefaultWakeDeps)
 * and should be smoke-tested on a preview env before production activation.
 */
export interface DeepAgentToolMaterializerConfig {
  llm: ICompletionBackend;
  model: string;
  logger: Logger;
}

export function createDeepAgentToolMaterializer(config: DeepAgentToolMaterializerConfig): ToolMaterializer {
  return async (enabledToolNames: string[], ownerUserId: string) => {
    if (enabledToolNames.length === 0) return [];

    const owner = (await userRepository.findById(ownerUserId)) as IUserDocument | null;
    if (!owner) {
      throw new Error(`deep agent tools: owner user ${ownerUserId} not found`);
    }

    const apiKeyTable = await buildSystemApiKeyTable(config.logger);
    const models = await getAvailableModels(apiKeyTable as ApiKeyTable);

    const toolDeps: ToolBuilderDeps = {
      userId: ownerUserId,
      user: owner,
      logger: config.logger,
      db: {
        apiKeys: apiKeyRepository,
        adminSettings: adminSettingsRepository,
        fabfiles: fabFileRepository,
        fabfilechunks: fabFileChunkRepository,
        users: userRepository,
        projects: projectRepository,
        dataLakes: dataLakeRepository,
        // Audit trail for images blocked by the image_generation/edit_image tools'
        // moderation gate. The gate itself is unconditional (constructed
        // inline in the tool) - this only wires the incident record, not the block.
        imageModerationIncidents: imageModerationIncidentRepository,
      },
      storage: getFilesStorage(),
      imageGenerateStorage: getGeneratedImageStorage(),
      imageProcessorLambdaName: Resource.ImageProcessor.name,
      llm: config.llm,
      model: config.model,
      precomputed: { adminSettingsEnforceCredits: false, models },
      apiKeyTable: apiKeyTable as ApiKeyTable,
    };

    // No-op callbacks: deep agents are headless (no websocket/quest doc to
    // update); per-iteration billing is handled separately.
    const toolCallbacks: ToolBuilderCallbacks = {
      onStatusUpdate: async () => {},
      onToolStart: async () => {},
      onToolFinish: async () => {},
    };

    // deep_research is gated behind a config flag in generateTools; enable it so
    // it materializes when a profile requests it.
    return (
      buildSharedTools(toolDeps, toolCallbacks, {
        enabledTools: enabledToolNames,
        config: { deep_research: true },
      }) ?? []
    );
  };
}
