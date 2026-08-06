import { describe, it, expect, vi } from 'vitest';
import { buildAlwaysOnFloorDetails, type AlwaysOnFloorInput } from './systemPromptFloorTelemetry';

// Deterministic stand-in for the real tiktoken counter: token count == char length.
const lengthCounter = (content: string) => Promise.resolve(content.length);

const base: AlwaysOnFloorInput = {
  artifactEmissionEnabled: true,
  artifactEmissionContent: 'ARTIFACT',
  isLocalModel: false,
  helpCenterContent: 'HELP',
};

describe('buildAlwaysOnFloorDetails', () => {
  it('itemizes both always-on floor blocks in stable order for a normal turn', async () => {
    const details = await buildAlwaysOnFloorDetails(base, lengthCounter);
    expect(details.map(d => d.name)).toEqual(['artifact_emission', 'help_center']);
    expect(details).toEqual([
      { source: 'admin', name: 'artifact_emission', tokenCount: 8, wasIncluded: true },
      { source: 'admin', name: 'help_center', tokenCount: 4, wasIncluded: true },
    ]);
  });

  it('marks artifact_emission excluded (0 tokens, disabled) when artifacts are off', async () => {
    const details = await buildAlwaysOnFloorDetails({ ...base, artifactEmissionEnabled: false }, lengthCounter);
    const artifact = details.find(d => d.name === 'artifact_emission');
    expect(artifact).toEqual({
      source: 'admin',
      name: 'artifact_emission',
      tokenCount: 0,
      wasIncluded: false,
      exclusionReason: 'disabled',
    });
  });

  it('marks help_center excluded (0 tokens, disabled) for local models', async () => {
    const details = await buildAlwaysOnFloorDetails({ ...base, isLocalModel: true }, lengthCounter);
    const help = details.find(d => d.name === 'help_center');
    expect(help).toEqual({
      source: 'admin',
      name: 'help_center',
      tokenCount: 0,
      wasIncluded: false,
      exclusionReason: 'disabled',
    });
  });

  // An enabled block the input budget could not fit is excluded for a completely different reason than
  // one an admin switched off, and reading 'disabled' would send someone to the wrong settings page.
  it('blames the token limit, not configuration, when the budget dropped an enabled block', async () => {
    const details = await buildAlwaysOnFloorDetails({ ...base, artifactEmissionDelivered: false }, lengthCounter);

    expect(details.find(d => d.name === 'artifact_emission')).toEqual({
      source: 'admin',
      name: 'artifact_emission',
      tokenCount: 0,
      wasIncluded: false,
      exclusionReason: 'token_limit',
    });
  });

  it('still blames configuration when the block was off, however it was delivered', async () => {
    const details = await buildAlwaysOnFloorDetails(
      { ...base, isLocalModel: true, helpCenterDelivered: false },
      lengthCounter
    );

    expect(details.find(d => d.name === 'help_center')?.exclusionReason).toBe('disabled');
  });

  // Callers that do not track delivery keep their existing rows, so the field is additive.
  it('treats an enabled block as delivered when the caller does not say', async () => {
    const details = await buildAlwaysOnFloorDetails(base, lengthCounter);

    expect(details.every(d => d.wasIncluded)).toBe(true);
    expect(details.some(d => d.exclusionReason)).toBe(false);
  });

  it('does not count tokens for an excluded block (no wasted tokenizer work)', async () => {
    const counter = vi.fn(lengthCounter);
    await buildAlwaysOnFloorDetails({ ...base, artifactEmissionEnabled: false, isLocalModel: true }, counter);
    expect(counter).not.toHaveBeenCalled();
  });

  it('counts each included block exactly once, with its own content', async () => {
    const counter = vi.fn(lengthCounter);
    await buildAlwaysOnFloorDetails(base, counter);
    expect(counter).toHaveBeenCalledTimes(2);
    expect(counter).toHaveBeenCalledWith('ARTIFACT');
    expect(counter).toHaveBeenCalledWith('HELP');
  });
});
