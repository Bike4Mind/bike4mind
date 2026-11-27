import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_EMISSION_PROMPT, CALLABLE_FUNCTIONS_PROMPT_NOTE } from '@bike4mind/common';

const { getSettingsValue, resolveCallableFunctionsEnabled } = vi.hoisted(() => ({
  getSettingsValue: vi.fn(),
  resolveCallableFunctionsEnabled: vi.fn(),
}));

vi.mock('@bike4mind/database', () => ({ adminSettingsRepository: { getSettingsValue } }));
vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({ resolveCallableFunctionsEnabled }));

const { agentArtifactPromptReaders } = await import('./agentExecutor.artifactPrompt');
const { resolveAgentArtifactEmissionPrompt } = await import('@bike4mind/server-utils/utils/artifactGate');

const user = { id: 'user-1' };
const logger = { warn: vi.fn() };

beforeEach(() => {
  vi.clearAllMocks();
  getSettingsValue.mockResolvedValue(undefined);
});

describe('agentArtifactPromptReaders', () => {
  it('reads the prompt and the data origins from the admin settings', async () => {
    const readers = agentArtifactPromptReaders(user, logger);
    await readers.readPromptSetting();
    await readers.readDataOriginsSetting();
    expect(getSettingsValue.mock.calls).toEqual([['ArtifactEmissionPrompt'], ['pythonArtifactDataOrigins']]);
  });

  it.each([true, false])('answers callable functions with the resolver for this person (%s)', async enabled => {
    resolveCallableFunctionsEnabled.mockResolvedValue(enabled);
    await expect(agentArtifactPromptReaders(user, logger).readCallableFunctionsEnabled()).resolves.toBe(enabled);
    expect(resolveCallableFunctionsEnabled).toHaveBeenCalledWith(user);
  });

  it('reads callable functions as off and logs when the resolver fails', async () => {
    resolveCallableFunctionsEnabled.mockRejectedValue(new Error('settings unavailable'));
    await expect(agentArtifactPromptReaders(user, logger).readCallableFunctionsEnabled()).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('gives the run the callable-function note exactly when the resolver says on', async () => {
    const prompt = () =>
      resolveAgentArtifactEmissionPrompt({ artifactsEnabled: true, ...agentArtifactPromptReaders(user, logger) });

    resolveCallableFunctionsEnabled.mockResolvedValue(false);
    await expect(prompt()).resolves.toBe(ARTIFACT_EMISSION_PROMPT);

    resolveCallableFunctionsEnabled.mockResolvedValue(true);
    await expect(prompt()).resolves.toBe(`${ARTIFACT_EMISSION_PROMPT}\n\n${CALLABLE_FUNCTIONS_PROMPT_NOTE}`);
  });
});
