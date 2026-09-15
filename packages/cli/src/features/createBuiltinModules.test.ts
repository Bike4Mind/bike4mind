import { describe, it, expect, afterEach } from 'vitest';
import { hearthSessionFromStore } from './createBuiltinModules.js';
import { useCliStore } from '../store/index.js';
import type { Session } from '../storage/types.js';

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
