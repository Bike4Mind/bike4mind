import type { AuthState } from '@shared/auth';
import { localModelId, type ChatModelOption } from '@shared/chat';
import type { ModelRuntimeStatus } from '@shared/models';
import { describe, expect, it } from 'vitest';
import { composerBlock, isLocalMode, noLocalModels } from './noLocalModels';

const model: ChatModelOption = { id: localModelId('ollama', 'qwen2.5:0.5b'), name: 'qwen2.5:0.5b' };
const computer = { serverId: 'local', serverName: 'This computer', management: 'allowed' } as const;
const up: ModelRuntimeStatus = {
  reachable: true,
  version: '0.9.0',
  url: 'http://127.0.0.1:11434',
  error: null,
  ...computer,
};
const down: ModelRuntimeStatus = {
  reachable: false,
  version: null,
  url: 'http://127.0.0.1:11434',
  error: 'refused',
  ...computer,
};

describe('noLocalModels', () => {
  it('says nothing while a model exists and Ollama answers, or the list is still loading', () => {
    expect(noLocalModels({ models: [model], loading: false, runtime: up })).toBeNull();
    expect(noLocalModels({ models: [model], loading: false, runtime: null })).toBeNull();
    expect(noLocalModels({ models: [], loading: true, runtime: null })).toBeNull();
  });

  it('names the address when Ollama is not reachable and offers no screen to open', () => {
    const state = noLocalModels({ models: [], loading: false, runtime: down });
    expect(state?.reason).toContain('Ollama is not running at http://127.0.0.1:11434');
    expect(state?.fix).toBeNull();
  });

  it('blocks when Ollama stops while models are still listed', () => {
    expect(noLocalModels({ models: [model], loading: false, runtime: down })).toMatchObject({ fix: null });
  });

  it('does not block while a saved server offers a model, even with Ollama on this computer down', () => {
    const remote: ChatModelOption = {
      id: localModelId('srv-abc123', 'qwen2.5:0.5b'),
      name: 'qwen2.5:0.5b',
      server: { id: 'abc123', name: 'gpu box' },
    };
    expect(noLocalModels({ models: [remote], loading: false, runtime: down })).toBeNull();
    expect(
      noLocalModels({ models: [{ ...remote, unavailable: 'gpu box is unreachable' }], loading: false, runtime: down })
    ).toMatchObject({ fix: null });
  });

  it('treats an unreadable status with an empty list as not running', () => {
    expect(noLocalModels({ models: [], loading: false, runtime: null })?.fix).toBeNull();
  });

  it('points at the Models screen when Ollama runs with no chat-capable model', () => {
    const state = noLocalModels({ models: [], loading: false, runtime: up });
    expect(state).toMatchObject({ fix: 'open-models' });
    expect(state?.reason).toContain('no models that can chat');
  });
});

describe('isLocalMode', () => {
  const state = (status: AuthState['status'], reauthRequired = false) => ({ status, reauthRequired }) as AuthState;

  it('is true signed out and false signed in or with an expired session', () => {
    expect(isLocalMode(state('signed-out'))).toBe(true);
    expect(isLocalMode(state('unconfigured'))).toBe(true);
    expect(isLocalMode(state('signed-in'))).toBe(false);
    expect(isLocalMode(state('signed-out', true))).toBe(false);
    expect(isLocalMode(null)).toBe(false);
  });
});

describe('composerBlock', () => {
  const noLocal = { reason: 'Ollama is running but has no models that can chat.', fix: 'open-models' as const };

  it('puts the local-mode reason ahead of the attachment reason and carries the Models action', () => {
    expect(composerBlock(noLocal, 'cannot read images')).toEqual({ reason: noLocal.reason, action: 'open-models' });
  });

  it('falls back to the attachment reason, and to nothing', () => {
    expect(composerBlock(null, 'cannot read images')).toEqual({ reason: 'cannot read images', action: null });
    expect(composerBlock(null, null)).toEqual({ reason: null, action: null });
    expect(composerBlock({ reason: 'down', fix: null }, null).action).toBeNull();
  });
});
