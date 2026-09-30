import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@server/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));

const h = vi.hoisted(() => ({
  revokeGitHubLakeConnection: vi.fn(),
}));

vi.mock('@server/integrations/github/dataLake/githubLakeConnection', () => ({
  revokeGitHubLakeConnection: h.revokeGitHubLakeConnection,
}));

import { dispatch } from './githubLakeRevoke';
import { ConflictError } from '@server/utils/errors';

const logger = { warn: vi.fn(), error: vi.fn(), info: vi.fn(), updateMetadata: vi.fn() } as never;
const run = (body: Record<string, unknown>) =>
  dispatch({ Records: [{ body: JSON.stringify(body) }] } as never, {} as never, logger);

beforeEach(() => {
  vi.clearAllMocks();
});

describe('githubLakeRevoke', () => {
  it('delegates to revokeGitHubLakeConnection with the parsed connectionId', async () => {
    await run({ connectionId: 'conn1' });
    expect(h.revokeGitHubLakeConnection).toHaveBeenCalledWith('conn1', logger);
  });

  it('swallows a malformed payload instead of retrying it forever', async () => {
    await expect(run({ nope: true })).resolves.toBeUndefined();
    expect(h.revokeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('swallows invalid JSON', async () => {
    await expect(dispatch({ Records: [{ body: '{not json' }] } as never, {} as never, logger)).resolves.toBeUndefined();
    expect(h.revokeGitHubLakeConnection).not.toHaveBeenCalled();
  });

  it('logs a warning and rethrows on a live-sync conflict, so SQS retries the message', async () => {
    h.revokeGitHubLakeConnection.mockRejectedValue(new ConflictError('A sync is in progress'));
    await expect(run({ connectionId: 'conn1' })).rejects.toThrow(ConflictError);
    expect(logger.warn).toHaveBeenCalledWith(
      '[githubLakeRevoke] sync in progress; message will retry',
      expect.objectContaining({ connectionId: 'conn1' })
    );
  });

  it('rethrows any other failure for SQS retry/DLQ, without the conflict-specific warning', async () => {
    h.revokeGitHubLakeConnection.mockRejectedValue(new Error('mongo down'));
    await expect(run({ connectionId: 'conn1' })).rejects.toThrow('mongo down');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
