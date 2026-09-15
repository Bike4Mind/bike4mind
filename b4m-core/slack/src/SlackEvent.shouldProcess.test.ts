import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * #2027 follow-up review: `shouldProcess`'s agentCommandPattern check ran against `this.text`
 * UNTRIMMED, while a caller's own cheap pre-check (events.ts's bare-mention widening) trims first.
 * Both sides are `^`-anchored, so a message with leading whitespace (easy to produce on mobile
 * Slack) passed the caller's cheap check but then failed this method's own match - the flag was
 * on, the user's intent was clear, and the message was still silently dropped. These tests pin
 * the fix: `shouldProcess` now trims before testing, matching what every anchored pattern already
 * assumes.
 */

const { findByKey, createOrUpdate } = vi.hoisted(() => ({
  findByKey: vi.fn(),
  createOrUpdate: vi.fn(),
}));
vi.mock('./di/registry', () => ({
  getSlackDb: () => ({ cacheRepository: { findByKey, createOrUpdate } }),
  getSlackDeps: vi.fn(),
  configureSlackPackage: vi.fn(),
}));

import { SlackEvent } from './SlackEvent';

const AGENT_PATTERN = /^@(agent|datalake)\b/i;

const makeEvent = (text: string) =>
  new SlackEvent({ type: 'message', channel: 'C1', user: 'U1', text, ts: '1700000000.0001' } as never);

beforeEach(() => {
  vi.clearAllMocks();
  findByKey.mockResolvedValue(null);
  createOrUpdate.mockResolvedValue(undefined);
});

describe('SlackEvent.shouldProcess - agentCommandPattern trimming', () => {
  it('processes a command with no leading whitespace (baseline)', async () => {
    const result = await makeEvent('@agent help').shouldProcess('evt-1', AGENT_PATTERN);
    expect(result.shouldProcess).toBe(true);
  });

  it('still processes a command preceded by leading whitespace', async () => {
    const result = await makeEvent(' @agent help').shouldProcess('evt-2', AGENT_PATTERN);
    expect(result.shouldProcess).toBe(true);
  });

  it('still processes a command preceded by a leading newline', async () => {
    const result = await makeEvent('\n@agent help').shouldProcess('evt-3', AGENT_PATTERN);
    expect(result.shouldProcess).toBe(true);
  });

  it('drops a plain message that does not match the pattern even when trimmed', async () => {
    const result = await makeEvent('  just chatting').shouldProcess('evt-4', AGENT_PATTERN);
    expect(result.shouldProcess).toBe(false);
    expect(result.reason).toBe('Does not meet processing criteria');
  });
});
