import { describe, it, expect, vi, beforeEach } from 'vitest';

// Resolve against the real allowlist (triage_router is activatable) but stub the DB-backed content
// loader so each test controls the "enabled with content" vs "admin-disabled -> null" outcomes that
// the suppression decision turns on.
const loadSystemPromptContent = vi.fn();
vi.mock('@server/utils/systemPrompts/loader', () => ({
  loadSystemPromptContent: (...args: unknown[]) => loadSystemPromptContent(...args),
}));

import {
  loadSystemPromptById,
  sessionWillInjectAuthoredPrompt,
  __resetResolvedPromptCache,
} from './sessionSystemPromptResolver';

beforeEach(() => {
  loadSystemPromptContent.mockReset();
  // Otherwise a prior test's cached resolution leaks into the next (same promptId, 60s TTL).
  __resetResolvedPromptCache();
});

describe('loadSystemPromptById', () => {
  it('never touches the loader for a non-activatable id', async () => {
    expect(await loadSystemPromptById('anything')).toBeNull();
    expect(loadSystemPromptContent).not.toHaveBeenCalled();
  });

  it('returns the resolved content for an activatable id', async () => {
    loadSystemPromptContent.mockResolvedValue({ content: 'ROUTER PROMPT', source: 'db' });
    expect(await loadSystemPromptById('triage_router')).toBe('ROUTER PROMPT');
  });

  it('returns null when the prompt is admin-disabled (loader returns null)', async () => {
    loadSystemPromptContent.mockResolvedValue(null);
    expect(await loadSystemPromptById('triage_router')).toBeNull();
  });

  it('caches the resolution so a busy session does not re-read every turn', async () => {
    loadSystemPromptContent.mockResolvedValue({ content: 'ROUTER PROMPT', source: 'db' });
    expect(await loadSystemPromptById('triage_router')).toBe('ROUTER PROMPT');
    expect(await loadSystemPromptById('triage_router')).toBe('ROUTER PROMPT');
    expect(loadSystemPromptContent).toHaveBeenCalledTimes(1);
  });
});

describe('sessionWillInjectAuthoredPrompt', () => {
  it('is true for raw authored text without resolving anything', async () => {
    expect(await sessionWillInjectAuthoredPrompt({ systemPromptText: 'you are a bagel' })).toBe(true);
    expect(loadSystemPromptContent).not.toHaveBeenCalled();
  });

  it('does not count whitespace-only text as authored', async () => {
    expect(await sessionWillInjectAuthoredPrompt({ systemPromptText: '   ' })).toBe(false);
  });

  it('is true for an activatable id that resolves to content', async () => {
    loadSystemPromptContent.mockResolvedValue({ content: 'ROUTER PROMPT', source: 'db' });
    expect(await sessionWillInjectAuthoredPrompt({ systemPromptId: 'triage_router' })).toBe(true);
  });

  // The P1 regression: an allowlisted id an admin has disabled (or a lake bound to a since-delisted
  // id) resolves to null. Membership alone reported true here, which suppressed the generic identity
  // AND injected nothing - a session with no system prompt at all. Resolving makes this FALSE.
  it('is FALSE for an activatable id that an admin has disabled', async () => {
    loadSystemPromptContent.mockResolvedValue(null);
    expect(await sessionWillInjectAuthoredPrompt({ systemPromptId: 'triage_router' })).toBe(false);
  });

  it('is false for a non-activatable id (never resolves a non-allowlisted prompt)', async () => {
    expect(await sessionWillInjectAuthoredPrompt({ systemPromptId: 'anything' })).toBe(false);
    expect(loadSystemPromptContent).not.toHaveBeenCalled();
  });

  it('is false for no prompt at all', async () => {
    expect(await sessionWillInjectAuthoredPrompt({})).toBe(false);
  });

  it('counts raw text even when a non-activatable id is also set, without resolving', async () => {
    expect(await sessionWillInjectAuthoredPrompt({ systemPromptText: 'real', systemPromptId: 'anything' })).toBe(true);
    expect(loadSystemPromptContent).not.toHaveBeenCalled();
  });
});
