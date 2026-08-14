import { describe, it, expect, vi } from 'vitest';
import type { BuilderInjectedBlock } from '@bike4mind/utils';
import {
  buildAlwaysOnFloorDetails,
  buildInjectedBlockDetails,
  type AlwaysOnFloorInput,
} from './systemPromptFloorTelemetry';

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

describe('buildInjectedBlockDetails', () => {
  const delivered = (id: 'formatPrompt' | 'imagePrompt', content: string): BuilderInjectedBlock => ({
    id,
    injected: true,
    delivered: true,
    content,
  });

  it('itemizes both rows in stable order for a normal turn', async () => {
    const blocks = [delivered('formatPrompt', 'FORMAT'), delivered('imagePrompt', 'IMAGE')];
    const details = await buildInjectedBlockDetails(blocks, lengthCounter);
    expect(details.map(d => d.name)).toEqual(['format_prompt', 'image_prompt']);
    expect(details).toEqual([
      { source: 'admin', name: 'format_prompt', tokenCount: 6, wasIncluded: true },
      { source: 'hardcoded', name: 'image_prompt', tokenCount: 5, wasIncluded: true },
    ]);
  });

  it('marks a not-injected block excluded (0 tokens, disabled)', async () => {
    const blocks: BuilderInjectedBlock[] = [
      { id: 'formatPrompt', injected: false, delivered: false, reason: 'setting_disabled' },
      delivered('imagePrompt', 'IMAGE'),
    ];
    const details = await buildInjectedBlockDetails(blocks, lengthCounter);
    expect(details.find(d => d.name === 'format_prompt')).toEqual({
      source: 'admin',
      name: 'format_prompt',
      tokenCount: 0,
      wasIncluded: false,
      exclusionReason: 'disabled',
    });
  });

  it('blames the token limit when the block was injected but the budget dropped it', async () => {
    const blocks: BuilderInjectedBlock[] = [
      { id: 'formatPrompt', injected: true, delivered: false, content: 'FORMAT' },
      delivered('imagePrompt', 'IMAGE'),
    ];
    const details = await buildInjectedBlockDetails(blocks, lengthCounter);
    expect(details.find(d => d.name === 'format_prompt')).toEqual({
      source: 'admin',
      name: 'format_prompt',
      tokenCount: 0,
      wasIncluded: false,
      exclusionReason: 'token_limit',
    });
  });

  it('still emits both rows for an empty input array (complete inventory, not just what was passed)', async () => {
    const details = await buildInjectedBlockDetails([], lengthCounter);
    expect(details.map(d => d.name)).toEqual(['format_prompt', 'image_prompt']);
    expect(details.every(d => !d.wasIncluded && d.exclusionReason === 'disabled')).toBe(true);
  });

  it('still emits a disabled row for an id missing from the input array', async () => {
    const details = await buildInjectedBlockDetails([delivered('imagePrompt', 'IMAGE')], lengthCounter);
    expect(details.find(d => d.name === 'format_prompt')).toEqual({
      source: 'admin',
      name: 'format_prompt',
      tokenCount: 0,
      wasIncluded: false,
      exclusionReason: 'disabled',
    });
  });

  it('does not count tokens for an excluded row', async () => {
    const counter = vi.fn(lengthCounter);
    await buildInjectedBlockDetails(
      [{ id: 'formatPrompt', injected: false, delivered: false, reason: 'mode_skipped' }],
      counter
    );
    expect(counter).not.toHaveBeenCalled();
  });

  it('counts each included row exactly once, with its own content', async () => {
    const counter = vi.fn(lengthCounter);
    await buildInjectedBlockDetails([delivered('formatPrompt', 'FORMAT'), delivered('imagePrompt', 'IMAGE')], counter);
    expect(counter).toHaveBeenCalledTimes(2);
    expect(counter).toHaveBeenCalledWith('FORMAT');
    expect(counter).toHaveBeenCalledWith('IMAGE');
  });
});
