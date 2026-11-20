import { describe, it, expect, vi } from 'vitest';
import { NotFoundError } from '@bike4mind/utils';
import { autoName, sanitizeSessionTitle } from './autoName';

describe('sanitizeSessionTitle (#8960)', () => {
  it('passes through a normal plain-text title', () => {
    expect(sanitizeSessionTitle('Classic sunset art request')).toBe('Classic sunset art request');
  });

  it('extracts a headline/title/name/subject from a JSON-object title', () => {
    expect(sanitizeSessionTitle('{ "editorialMode": "grin", "headline": "The Epistemology of Cats" }')).toBe(
      'The Epistemology of Cats'
    );
    expect(sanitizeSessionTitle('{"title":"T","name":"N"}')).toBe('T');
    expect(sanitizeSessionTitle('{"subject":"S"}')).toBe('S');
  });

  it('falls back to the first string value when no labeled field exists', () => {
    expect(sanitizeSessionTitle('{"lens":"claims","confidence":0.85,"reasoning":"Technical STEM"}')).toBe('claims');
  });

  it('clamps long titles to 80 chars with an ellipsis', () => {
    const out = sanitizeSessionTitle('a'.repeat(200));
    expect(out.length).toBe(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('never persists a multi-KB JSON body verbatim', () => {
    const raw = JSON.stringify({ headline: 'Parked car as grid battery', body: 'x'.repeat(2000) });
    expect(sanitizeSessionTitle(raw)).toBe('Parked car as grid battery');
  });

  it('strips wrapping quotes/asterisks and collapses newlines', () => {
    expect(sanitizeSessionTitle('  "Hello"  ')).toBe('Hello');
    expect(sanitizeSessionTitle('**Bold title**')).toBe('Bold title');
    expect(sanitizeSessionTitle('line one\nline two')).toBe('line one line two');
  });

  it('returns a fallback for empty or unusable input', () => {
    expect(sanitizeSessionTitle('')).toBe('Untitled session');
    expect(sanitizeSessionTitle('{}')).toBe('Untitled session');
  });

  it('treats malformed JSON-looking strings as plain text', () => {
    expect(sanitizeSessionTitle('{not valid json')).toBe('{not valid json');
  });

  it('strips wrapping underscores and backticks', () => {
    expect(sanitizeSessionTitle('_Hello_')).toBe('Hello');
    expect(sanitizeSessionTitle('`code title`')).toBe('code title');
  });

  it('does not split a surrogate pair when clamping (no lone surrogate)', () => {
    const out = sanitizeSessionTitle('😀'.repeat(100));
    expect(out.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(out)).toBe(false);
  });
});

describe('autoName write-time re-check', () => {
  const writer = { id: 'sharee', groups: [] };
  const makeAdapters = () => ({
    db: {
      sessions: {
        findById: vi.fn().mockResolvedValue({ id: 's1' }),
        update: vi.fn(),
        updateWithUpdateAccess: vi.fn().mockResolvedValue({ id: 's1', name: 'Title' }),
      },
      quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue([{ prompt: 'p', reply: 'r' }]) },
    },
    createCompletion: vi.fn().mockResolvedValue('Title'),
    logger: { info: vi.fn() },
  });

  it('writes through the gated update for a request-driven rename, global-write included', async () => {
    const adapters = makeAdapters();

    await autoName({ sessionId: 's1' }, adapters as never, writer);

    expect(adapters.db.sessions.updateWithUpdateAccess).toHaveBeenCalledWith(
      writer,
      { id: 's1', name: 'Title', isAutoNamed: true },
      { includeGlobalWrite: true }
    );
    expect(adapters.db.sessions.update).not.toHaveBeenCalled();
  });

  it('answers NotFoundError when access was revoked during the LLM call', async () => {
    const adapters = makeAdapters();
    adapters.db.sessions.updateWithUpdateAccess.mockResolvedValue(null);

    await expect(autoName({ sessionId: 's1' }, adapters as never, writer)).rejects.toThrow(NotFoundError);
  });
});

describe('autoName input', () => {
  const makeAdapters = (
    history: Record<string, unknown>[],
    files?: { findAccessibleInIds: ReturnType<typeof vi.fn> }
  ) => ({
    db: {
      sessions: {
        findById: vi.fn().mockResolvedValue({ id: 's1' }),
        update: vi.fn(),
      },
      quests: { getMostRecentChatHistory: vi.fn().mockResolvedValue(history) },
      ...(files ? { files, fileAccess: { userId: 'user-1', userGroups: ['group-1'] } } : {}),
    },
    createCompletion: vi.fn().mockResolvedValue('Title'),
    logger: { info: vi.fn(), warn: vi.fn() },
  });
  const sentPrompt = (adapters: ReturnType<typeof makeAdapters>) =>
    adapters.createCompletion.mock.calls[0][0] as string;

  it('names from a turn that has no reply yet', async () => {
    const adapters = makeAdapters([{ prompt: 'Plan a trip to Kyoto', reply: null, replies: [] }]);

    await autoName({ sessionId: 's1' }, adapters as never);

    expect(sentPrompt(adapters)).toContain('Request: Plan a trip to Kyoto');
    expect(sentPrompt(adapters)).not.toContain('Answer:');
    expect(adapters.db.sessions.update).toHaveBeenCalledWith({ id: 's1', name: 'Title', isAutoNamed: true });
  });

  it('lists the attachment names of each turn', async () => {
    const files = { findAccessibleInIds: vi.fn().mockResolvedValue([{ id: 'f1', fileName: 'q3-forecast.xlsx' }]) };
    const adapters = makeAdapters([{ prompt: 'summarize', reply: null, fabFileIds: ['f1'] }], files);

    await autoName({ sessionId: 's1' }, adapters as never);

    expect(files.findAccessibleInIds).toHaveBeenCalledWith(['f1'], { userId: 'user-1', userGroups: ['group-1'] });
    expect(sentPrompt(adapters)).toContain('Request: summarize\nAttachments: q3-forecast.xlsx');
  });

  it('omits attachment names for files not returned by the accessible lookup', async () => {
    const files = { findAccessibleInIds: vi.fn().mockResolvedValue([{ id: 'f1', fileName: 'forecast.xlsx' }]) };
    const adapters = makeAdapters([{ prompt: 'summarize', reply: null, fabFileIds: ['f1', 'f2'] }], files);

    await autoName({ sessionId: 's1' }, adapters as never);

    expect(files.findAccessibleInIds).toHaveBeenCalledWith(['f1', 'f2'], {
      userId: 'user-1',
      userGroups: ['group-1'],
    });
    expect(sentPrompt(adapters)).toMatch(/Request: summarize\nAttachments: forecast\.xlsx$/);
  });

  it('still names when the attachment lookup fails', async () => {
    const files = { findAccessibleInIds: vi.fn().mockRejectedValue(new Error('db down')) };
    const adapters = makeAdapters([{ prompt: 'summarize', reply: null, fabFileIds: ['f1'] }], files);

    await autoName({ sessionId: 's1' }, adapters as never);

    expect(adapters.logger.warn).toHaveBeenCalled();
    expect(sentPrompt(adapters)).toContain('Request: summarize');
    expect(sentPrompt(adapters)).not.toContain('Attachments:');
  });
});
