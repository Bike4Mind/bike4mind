import { describe, it, expect, vi } from 'vitest';
import type { ModelInfo } from '@bike4mind/common';
import { performModelSwitch, MODEL_SWITCH_BUSY_MESSAGE, type ModelSwitchDeps } from './performModelSwitch';

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
