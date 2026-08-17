import { describe, expect, it } from 'vitest';
import { resolveAgentArtifactGate } from './agentExecutor.artifactGate';

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

  it('reads an unreadable admin setting as on, matching the setting prefault', () => {
    expect(resolveAgentArtifactGate({})).toBe(true);
    expect(resolveAgentArtifactGate({ startPayloadEnableArtifacts: false })).toBe(false);
  });
});
