import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Regression tests for issue #2026: `triggerAIResponseWithContext` used to flatten every
 * failure - a real, specific Quest error AND any thrown exception - into the same hardcoded
 * "Sorry, I encountered an error processing your request." string, discarding the real cause
 * that was already being logged server-side. These pin the fix: a failed Quest's own
 * `reply` is surfaced (length-capped, since it may be ChatCompletionProcess's curated
 * message OR an unclassified raw error - there is no flag distinguishing the two), and a
 * thrown HTTPError's message is surfaced from the outer catch via a realm-safe duck-typed
 * check - while an unrecognized/uncategorized failure still falls back to the generic
 * string rather than leaking internal detail to a public Slack channel.
 */

const { getSlackDeps, getSlackDb, invoke, findQuestById } = vi.hoisted(() => ({
  getSlackDeps: vi.fn(),
  getSlackDb: vi.fn(),
  invoke: vi.fn(),
  findQuestById: vi.fn(),
}));
vi.mock('./di/registry', () => ({ getSlackDeps, getSlackDb, configureSlackPackage: vi.fn() }));
vi.mock('@bike4mind/services', () => ({
  ChatCompletionInvoke: function MockChatCompletionInvoke() {
    return { invoke, db: { quests: { findById: findQuestById } } };
  },
}));

import { CommandHandler } from './CommandHandler';
import { SlackEvent } from './SlackEvent';
import { BadRequestError } from '@bike4mind/common';

const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

function makeHandler() {
  const slackEvent = new SlackEvent({
    channel: 'C1',
    user: 'U1',
    text: 'hey, what is the status of the release?',
    ts: '1700000000.0001',
  } as never);
  return new CommandHandler(slackEvent, { id: 'user-1', organizationId: undefined } as never, {} as never, logger);
}

beforeEach(() => {
  vi.clearAllMocks();
  getSlackDb.mockReturnValue({
    User: { findById: vi.fn().mockResolvedValue({ id: 'user-1' }) },
    SlackChannelConfig: { findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) },
    Organization: {
      findById: vi.fn().mockReturnValue({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) }) }),
    },
  });
  getSlackDeps.mockReturnValue({
    chatCompletionDefaults: {
      defaultChatCompletionOptions: {},
      getSharedTokenizer: vi.fn(),
    },
    eventBus: { LLMEvents: { CompletionStart: { publish: vi.fn() } } },
  });
});

describe('triggerAIResponseWithContext', () => {
  it("surfaces the failed quest's own reply instead of the generic string", async () => {
    invoke.mockResolvedValue({ id: 'quest-1' });
    findQuestById.mockResolvedValue({
      type: 'error',
      reply: 'The AI service is currently experiencing high demand. Please try again in a few minutes.',
    });

    const result = await makeHandler().triggerAIResponseWithContext('session-1', 'hi', '');

    expect(result).toBe('The AI service is currently experiencing high demand. Please try again in a few minutes.');
    expect(logger.error).toHaveBeenCalledWith(
      'Quest failed:',
      'The AI service is currently experiencing high demand. Please try again in a few minutes.'
    );
  });

  it('falls back to the generic string when the failed quest has no reply', async () => {
    invoke.mockResolvedValue({ id: 'quest-1' });
    findQuestById.mockResolvedValue({ type: 'error', reply: '' });

    const result = await makeHandler().triggerAIResponseWithContext('session-1', 'hi', '');

    expect(result).toBe('Sorry, I encountered an error processing your request.');
  });

  it('caps an oversized quest reply instead of relaying it verbatim', async () => {
    invoke.mockResolvedValue({ id: 'quest-1' });
    const longReply = 'x'.repeat(400);
    findQuestById.mockResolvedValue({ type: 'error', reply: longReply });

    const result = await makeHandler().triggerAIResponseWithContext('session-1', 'hi', '');

    expect(result).toBe(`${'x'.repeat(300)}...`);
  });

  it('surfaces an HTTPError message thrown before/during invoke()', async () => {
    invoke.mockRejectedValue(new BadRequestError('Invalid model: "gpt-nope" is not available'));

    const result = await makeHandler().triggerAIResponseWithContext('session-1', 'hi', '');

    expect(result).toBe('Invalid model: "gpt-nope" is not available');
    expect(logger.error).toHaveBeenCalledWith('Error triggering AI response:', expect.any(BadRequestError));
  });

  it('surfaces the message from an HTTPError-shaped error that fails instanceof (cross-realm)', async () => {
    // Simulates @bike4mind/common resolving as two module realms: a plain object shaped
    // like an HTTPError (has statusCode + message) but NOT an instance of the imported
    // HTTPError class - this is exactly what isHttpError's duck-type fallback is for.
    const crossRealmError = Object.assign(new Error('Invalid model: "gpt-nope" is not available'), {
      statusCode: 400,
    });
    invoke.mockRejectedValue(crossRealmError);

    const result = await makeHandler().triggerAIResponseWithContext('session-1', 'hi', '');

    expect(result).toBe('Invalid model: "gpt-nope" is not available');
  });

  it('keeps the generic string for an unrecognized thrown error', async () => {
    invoke.mockRejectedValue(new Error('ECONNRESET at socket layer'));

    const result = await makeHandler().triggerAIResponseWithContext('session-1', 'hi', '');

    expect(result).toBe('Sorry, I encountered an error processing your request.');
  });
});
