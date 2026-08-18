import { describe, expect, it, vi } from 'vitest';
import { ARTIFACT_EMISSION_PROMPT } from '@bike4mind/common';
import { resolveAgentArtifactEmissionPrompt, resolveAgentArtifactGate } from './agentExecutor.artifactGate';

describe('resolveAgentArtifactGate', () => {
  it('requires the admin setting: no caller flag can turn artifacts back on', () => {
    expect(resolveAgentArtifactGate({ adminEnableArtifacts: false, startPayloadEnableArtifacts: true })).toBe(false);
    expect(resolveAgentArtifactGate({ adminEnableArtifacts: false, executionEnableArtifacts: true })).toBe(false);
  });

  it('honours an explicit caller opt-out on the start payload', () => {
    expect(resolveAgentArtifactGate({ adminEnableArtifacts: true, startPayloadEnableArtifacts: false })).toBe(false);
  });

  it('falls back to the persisted doc so a continuation keeps the opt-out', () => {
    // The SQS continuation payload carries only executionId + connectionId, so the start payload is
    // gone by the second iteration. Reading it alone would flip the gate back on mid-run.
    expect(resolveAgentArtifactGate({ adminEnableArtifacts: true, executionEnableArtifacts: false })).toBe(false);
  });

  it('prefers the start payload over the doc when both are present', () => {
    expect(
      resolveAgentArtifactGate({
        adminEnableArtifacts: true,
        startPayloadEnableArtifacts: false,
        executionEnableArtifacts: true,
      })
    ).toBe(false);
    expect(
      resolveAgentArtifactGate({
        adminEnableArtifacts: true,
        startPayloadEnableArtifacts: true,
        executionEnableArtifacts: false,
      })
    ).toBe(true);
  });

  it('leaves the admin setting as the only gate when no caller expressed a preference', () => {
    // Regression lock, mirroring resolveArtifactsEnabled: absence is not `false`. Most internal
    // dispatches never set the flag, and reading absence as off would strip artifacts from all of them.
    expect(resolveAgentArtifactGate({ adminEnableArtifacts: true })).toBe(true);
    expect(resolveAgentArtifactGate({ adminEnableArtifacts: false })).toBe(false);
  });

  it('reads an absent admin setting as on, matching the setting prefault', () => {
    // Only expressible because the repository's return type admits `undefined`; production cannot
    // produce it (the setting `.prefault`s to true and falls back to the same default on a parse
    // failure). Locked so a future caller that CAN pass `undefined` does not silently gate off.
    expect(resolveAgentArtifactGate({})).toBe(true);
    expect(resolveAgentArtifactGate({ startPayloadEnableArtifacts: false })).toBe(false);
  });
});

describe('resolveAgentArtifactEmissionPrompt', () => {
  const readPromptSetting = () => Promise.resolve('CUSTOM PROMPT');

  it('withholds the prompt when the gate resolved off', async () => {
    // The assembly-site conditional, not the gate, is what a refactor drops silently - which is why
    // both agent-executor call sites route through this helper instead of repeating the ternary.
    await expect(
      resolveAgentArtifactEmissionPrompt({ artifactsEnabled: false, isNewExecution: true, readPromptSetting })
    ).resolves.toBeUndefined();
  });

  it('never reads the prompt setting when it is going to withhold it', async () => {
    const read = vi.fn(readPromptSetting);

    await resolveAgentArtifactEmissionPrompt({ artifactsEnabled: false, readPromptSetting: read });

    expect(read).not.toHaveBeenCalled();
  });

  it('injects the configured prompt when the gate resolved on', async () => {
    await expect(
      resolveAgentArtifactEmissionPrompt({ artifactsEnabled: true, isNewExecution: true, readPromptSetting })
    ).resolves.toBe('CUSTOM PROMPT');
  });

  it('falls back to the built-in prompt when the setting is unset or blank', async () => {
    // Must match the chat path's getSettingsValue(..., ARTIFACT_EMISSION_PROMPT) default.
    await expect(
      resolveAgentArtifactEmissionPrompt({ artifactsEnabled: true, readPromptSetting: async () => undefined })
    ).resolves.toBe(ARTIFACT_EMISSION_PROMPT);
    await expect(
      resolveAgentArtifactEmissionPrompt({ artifactsEnabled: true, readPromptSetting: async () => '' })
    ).resolves.toBe(ARTIFACT_EMISSION_PROMPT);
  });

  it('withholds the prompt on a continuation, which already carries the composed system message', async () => {
    await expect(
      resolveAgentArtifactEmissionPrompt({ artifactsEnabled: true, isNewExecution: false, readPromptSetting })
    ).resolves.toBeUndefined();
  });

  it('treats a dispatched child as new, since it runs fresh with no checkpoint', async () => {
    await expect(resolveAgentArtifactEmissionPrompt({ artifactsEnabled: true, readPromptSetting })).resolves.toBe(
      'CUSTOM PROMPT'
    );
  });
});
