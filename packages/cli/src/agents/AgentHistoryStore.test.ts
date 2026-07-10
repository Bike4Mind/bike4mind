import { describe, it, expect } from 'vitest';
import type { AgentCheckpoint } from '@bike4mind/agents';
import { AgentHistoryStore, type StoredAgentHistory } from './AgentHistoryStore.js';
import type { AgentDefinition } from './types.js';
import { MAX_SUBAGENT_HISTORY_ENTRIES } from '../config/constants.js';

function makeDefinition(): AgentDefinition {
  return {
    name: 'explore',
    description: 'test agent',
    model: 'test-model',
    modelResolved: true,
    systemPrompt: 'You are a test agent.',
    maxIterations: { quick: 1, medium: 1, very_thorough: 1 },
    defaultThoroughness: 'quick',
    source: 'builtin',
    filePath: '<test>',
    retry: { maxRetries: 0, initialDelayMs: 0 },
  };
}

function makeCheckpoint(): AgentCheckpoint {
  return {
    iteration: 1,
    messages: [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ],
    steps: [],
    totalTokens: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheReadTokens: 0,
    totalCacheWriteTokens: 0,
    totalCredits: 0,
    toolCallCount: 0,
    confidenceLog: [],
    iterationConfidences: [],
  };
}

function makeEntry(overrides: Partial<StoredAgentHistory> = {}): StoredAgentHistory {
  return {
    checkpoint: makeCheckpoint(),
    agentName: 'explore',
    agentDefinition: makeDefinition(),
    thoroughness: 'medium',
    parentSessionId: 'session-1',
    endTime: Date.now(),
    ...overrides,
  };
}

describe('AgentHistoryStore', () => {
  it('stores and retrieves an entry by id', () => {
    const store = new AgentHistoryStore();
    const entry = makeEntry();
    store.set('bg-abc', entry);

    expect(store.has('bg-abc')).toBe(true);
    expect(store.get('bg-abc')).toBe(entry);
    expect(store.size()).toBe(1);
  });

  it('returns undefined for an unknown id', () => {
    const store = new AgentHistoryStore();
    expect(store.get('missing')).toBeUndefined();
    expect(store.has('missing')).toBe(false);
  });

  it('deletes an entry', () => {
    const store = new AgentHistoryStore();
    store.set('bg-abc', makeEntry());
    expect(store.delete('bg-abc')).toBe(true);
    expect(store.has('bg-abc')).toBe(false);
    expect(store.delete('bg-abc')).toBe(false);
  });

  it('evicts entries older than the TTL when a new one is stored', () => {
    const ttlMs = 1000;
    const store = new AgentHistoryStore(ttlMs);
    // An entry that finished well before the TTL window is evicted by the
    // cleanup that set() runs immediately.
    store.set('stale', makeEntry({ endTime: Date.now() - (ttlMs + 5000) }));
    expect(store.has('stale')).toBe(false);

    // A fresh entry is retained.
    store.set('fresh', makeEntry());
    expect(store.has('fresh')).toBe(true);
  });

  it('keeps entries within the TTL window', () => {
    const store = new AgentHistoryStore(60_000);
    store.set('a', makeEntry({ endTime: Date.now() - 1000 }));
    store.set('b', makeEntry());
    expect(store.has('a')).toBe(true);
    expect(store.has('b')).toBe(true);
    expect(store.size()).toBe(2);
  });

  it('falls back to the default TTL when given a non-positive value (never silently disables)', () => {
    // 0 or negative would otherwise evict on the next set(); the store floors to the default.
    for (const bad of [0, -1000]) {
      const store = new AgentHistoryStore(bad);
      store.set('a', makeEntry());
      expect(store.has('a')).toBe(true);
    }
  });

  it('caps total retained entries', () => {
    // Long TTL so only the count cap can evict.
    const store = new AgentHistoryStore(24 * 60 * 60 * 1000);
    for (let i = 0; i < MAX_SUBAGENT_HISTORY_ENTRIES + 5; i++) {
      store.set(`job-${i}`, makeEntry());
    }
    expect(store.size()).toBeLessThanOrEqual(MAX_SUBAGENT_HISTORY_ENTRIES);
    // Oldest were dropped; the most recent survive.
    expect(store.has(`job-${MAX_SUBAGENT_HISTORY_ENTRIES + 4}`)).toBe(true);
    expect(store.has('job-0')).toBe(false);
  });
});
