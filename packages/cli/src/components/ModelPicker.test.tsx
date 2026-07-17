import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import type { ModelInfo } from '@bike4mind/common';
import { ModelPicker } from './ModelPicker';

const model = (id: string, name: string): ModelInfo =>
  ({ id, name, type: 'text', backend: 'openai', contextWindow: 128000, max_tokens: 4096 }) as unknown as ModelInfo;

const models: ModelInfo[] = [
  model('claude-opus-4-8', 'Claude Opus 4.8'),
  model('claude-sonnet-5', 'Claude Sonnet 5'),
  model('gpt-4.1-mini', 'GPT-4.1 mini'),
];

// ink-testing-library applies state-driven re-renders on the next tick, so
// input-driven assertions must yield before reading the frame.
const tick = () => new Promise(resolve => setTimeout(resolve, 20));

describe('ModelPicker', () => {
  it('lists every model and marks the current one', () => {
    const { lastFrame } = render(
      <ModelPicker models={models} currentModelId="claude-sonnet-5" onSelect={() => {}} onCancel={() => {}} />
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('Claude Opus 4.8');
    expect(frame).toContain('Claude Sonnet 5');
    expect(frame).toContain('GPT-4.1 mini');
    // The current model is prefixed with a filled dot marker.
    expect(frame).toMatch(/●\s+Claude Sonnet 5/);
  });

  it('filters the list as the user types', async () => {
    const { stdin, lastFrame } = render(
      <ModelPicker models={models} currentModelId="claude-sonnet-5" onSelect={() => {}} onCancel={() => {}} />
    );
    stdin.write('gpt');
    await tick();
    const frame = lastFrame() ?? '';
    expect(frame).toContain('GPT-4.1 mini');
    expect(frame).not.toContain('Claude Opus 4.8');
  });

  it('selects the highlighted model on Enter', () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      <ModelPicker models={models} currentModelId="claude-sonnet-5" onSelect={onSelect} onCancel={() => {}} />
    );
    stdin.write('\r');
    expect(onSelect).toHaveBeenCalledWith(models[0]);
  });

  it('cancels on Escape', async () => {
    const onCancel = vi.fn();
    const { stdin } = render(
      <ModelPicker models={models} currentModelId="claude-sonnet-5" onSelect={() => {}} onCancel={onCancel} />
    );
    stdin.write('\x1b');
    await tick();
    expect(onCancel).toHaveBeenCalled();
  });
});
