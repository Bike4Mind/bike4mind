import { describe, it, expect, afterEach } from 'vitest';
import { createBuiltinModules, hearthSessionFromStore } from './createBuiltinModules.js';
import { useCliStore } from '../store/index.js';
import type { Session } from '../storage/types.js';
import type { ApiClient } from '../auth/ApiClient.js';
import { createMockConfig } from '../test-utils/mocks.js';

describe('createBuiltinModules', () => {
  const config = createMockConfig({ features: { tavern: true, hearth: true } });

  it('builds the cloud modules a signed-in config enables', () => {
    expect(createBuiltinModules(config, { signedOut: false } as ApiClient)).toHaveLength(2);
  });

  it('builds none while signed out', () => {
    expect(createBuiltinModules(config, { signedOut: true } as ApiClient)).toEqual([]);
  });
});

const session = {
  id: 'session-1',
  name: 'Test session',
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  model: 'claude',
  messages: [],
  metadata: { totalTokens: 0, totalCost: 0, toolCallCount: 0 },
} as unknown as Session;

afterEach(() => {
  useCliStore.setState({ session: null });
});

describe('hearthSessionFromStore', () => {
  it('is undefined before a session exists, so no write mints an actor early', () => {
    useCliStore.setState({ session: null });
    expect(hearthSessionFromStore()).toBeUndefined();
  });

  // Every hearth_* write is an LLM tool call, so the session says agent: without
  // it the server's no-kind branch resolved to 'human' and the account's own
  // agent traffic badged as Human, indistinguishable from the owner typing.
  it('declares the CLI session an agent and carries the notebook name as the label', () => {
    useCliStore.setState({ session });
    expect(hearthSessionFromStore()).toEqual({ id: 'session-1', label: 'Test session', kind: 'agent' });
  });
});
