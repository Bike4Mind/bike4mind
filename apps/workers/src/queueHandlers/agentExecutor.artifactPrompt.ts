import { adminSettingsRepository } from '@bike4mind/database';
import type { Logger } from '@bike4mind/observability';
import { resolveCallableFunctionsSafely } from '@bike4mind/services/llm/artifactGating';
import { resolveCallableFunctionsEnabled } from '@bike4mind/server-utils/callableFunctions/access';

/**
 * The reads behind one run's artifact prompt (`resolveAgentArtifactEmissionPrompt`), shared by the top-level run and
 * dispatched children so both answer for the same requester as the chat path does.
 */
export function agentArtifactPromptReaders(user: { id: string }, logger: Pick<Logger, 'warn'>) {
  return {
    readPromptSetting: () => adminSettingsRepository.getSettingsValue('ArtifactEmissionPrompt'),
    readDataOriginsSetting: () => adminSettingsRepository.getSettingsValue('pythonArtifactDataOrigins'),
    readCallableFunctionsEnabled: () =>
      resolveCallableFunctionsSafely(() => resolveCallableFunctionsEnabled(user), logger),
  };
}
