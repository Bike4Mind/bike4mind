import { describe, it, expect, vi } from 'vitest';
import { createNotify, exitCodeFor, requireWebsocketEndpoint, summaryMessage } from './reconcilePurchaseStampsCli';

describe('exitCodeFor', () => {
  it('is 0 when clean, 1 on errors, 2 when blocking even with errors', () => {
    expect(exitCodeFor({ blocking: 0, errors: [] })).toBe(0);
    expect(exitCodeFor({ blocking: 0, errors: [{ id: 'pi_1', message: 'x' }] })).toBe(1);
    expect(exitCodeFor({ blocking: 1, errors: [] })).toBe(2);
    expect(exitCodeFor({ blocking: 2, errors: [{ id: 'pi_1', message: 'x' }] })).toBe(2);
  });
});

describe('requireWebsocketEndpoint', () => {
  it('skips the lookup on a dry run', () => {
    const read = vi.fn(() => 'wss://ws');
    expect(requireWebsocketEndpoint(false, read)).toBe('');
    expect(read).not.toHaveBeenCalled();
  });

  it('returns the endpoint when applying', () => {
    expect(requireWebsocketEndpoint(true, () => 'wss://ws')).toBe('wss://ws');
  });

  it('returns null when applying with an empty or unreadable endpoint', () => {
    expect(requireWebsocketEndpoint(true, () => '')).toBeNull();
    expect(
      requireWebsocketEndpoint(true, () => {
        throw new Error('no resource');
      })
    ).toBeNull();
  });
});

describe('createNotify', () => {
  it('invalidates the model and entitlement queries on the given endpoint', async () => {
    const send = vi.fn(async () => undefined);

    await createNotify('wss://ws', send)('user-1');

    expect(send.mock.calls).toEqual([
      ['user-1', 'wss://ws', { action: 'invalidate_query', queryKey: ['llm', 'models'] }],
      ['user-1', 'wss://ws', { action: 'invalidate_query', queryKey: ['entitlements'] }],
    ]);
  });

  it('does not reject when a send fails', async () => {
    const send = vi.fn(async () => {
      throw new Error('gone');
    });

    await expect(createNotify('wss://ws', send)('user-1')).resolves.toHaveLength(2);
  });
});

describe('summaryMessage', () => {
  it('reports the stage and counts', () => {
    expect(summaryMessage('prod', { cleared: 3, reversals: [{}, {}] as never })).toBe(
      'Paid standing reconcile (prod): cleared 3 stamp(s), reversed 2 purchase(s)'
    );
  });
});
