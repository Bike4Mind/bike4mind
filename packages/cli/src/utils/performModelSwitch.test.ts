import { describe, it, expect, vi } from 'vitest';
import { ModelBackend, type ModelInfo } from '@bike4mind/common';
import {
  modelSavePatch,
  performModelSwitch,
  MODEL_SWITCH_BUSY_MESSAGE,
  type ModelSwitchDeps,
} from './performModelSwitch';

describe('modelSavePatch', () => {
  const DETECTED = 'http://127.0.0.1:11434';
  const ollama = { id: 'qwen3.5', backend: ModelBackend.Ollama };

  it('saves the detected host and local default with a detected Ollama model', () => {
    expect(modelSavePatch(ollama, {}, DETECTED)).toEqual({
      defaultModel: 'qwen3.5',
      ollamaHost: DETECTED,
      localDefaultModel: 'qwen3.5',
    });
  });

  it.each([
    ['a hosted model', { id: 'claude-opus-4-8', backend: ModelBackend.Anthropic }, {}, DETECTED],
    ['a saved model server model', { id: 'local:srv-a:qwen', backend: ModelBackend.Ollama }, {}, DETECTED],
    ['a host that is already saved', ollama, { ollamaHost: 'box' }, DETECTED],
    ['no detected host', ollama, {}, null],
  ])('saves only the model for %s', (_name, picked, config, detected) => {
    expect(modelSavePatch(picked, config, detected)).toEqual({ defaultModel: picked.id });
  });
});

const model = { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' } as unknown as ModelInfo;

const makeDeps = (overrides: Partial<ModelSwitchDeps> = {}) => {
  const deps: ModelSwitchDeps = {
    isBusy: () => false,
    saveModel: vi.fn().mockResolvedValue(undefined),
    applyToSession: vi.fn(),
    log: vi.fn(),
    error: vi.fn(),
    ...overrides,
  };
  return deps;
};

describe('performModelSwitch', () => {
  it('saves, applies to the session, and confirms', async () => {
    const deps = makeDeps();
    await performModelSwitch(model, deps);

    expect(deps.saveModel).toHaveBeenCalledWith('claude-opus-4-8');
    expect(deps.applyToSession).toHaveBeenCalledWith('claude-opus-4-8');
    expect(deps.log).toHaveBeenCalledWith('✅ Switched to Claude Opus 4.8 (claude-opus-4-8)');
    expect(deps.error).not.toHaveBeenCalled();
  });

  // Guards the picker entry point, which previously called through with no
  // busy check: a mid-run swap splits one response across two models.
  it('refuses to switch while a response is streaming, without saving', async () => {
    const deps = makeDeps({ isBusy: () => true });
    await performModelSwitch(model, deps);

    expect(deps.saveModel).not.toHaveBeenCalled();
    expect(deps.applyToSession).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(MODEL_SWITCH_BUSY_MESSAGE);
  });

  it('leaves the session alone when a run starts during the save', async () => {
    let busy = false;
    const deps = makeDeps({
      isBusy: () => busy,
      saveModel: vi.fn().mockImplementation(async () => {
        busy = true;
      }),
    });
    await performModelSwitch(model, deps);

    expect(deps.saveModel).toHaveBeenCalledWith('claude-opus-4-8');
    expect(deps.applyToSession).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('this session keeps its current model'));
    expect(deps.log).not.toHaveBeenCalledWith(expect.stringContaining('Switched to'));
  });

  it('surfaces a save failure and does not touch the session', async () => {
    const deps = makeDeps({ saveModel: vi.fn().mockRejectedValue(new Error('EACCES')) });
    await performModelSwitch(model, deps);

    expect(deps.applyToSession).not.toHaveBeenCalled();
    expect(deps.error).toHaveBeenCalledWith('Failed to switch model: EACCES');
    expect(deps.log).not.toHaveBeenCalled();
  });

  it('stringifies a non-Error rejection', async () => {
    const deps = makeDeps({ saveModel: vi.fn().mockRejectedValue('disk full') });
    await performModelSwitch(model, deps);

    expect(deps.error).toHaveBeenCalledWith('Failed to switch model: disk full');
  });
});
