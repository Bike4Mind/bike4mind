import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, SQSEvent } from 'aws-lambda';

const h = vi.hoisted(() => ({ completeAccountDeletion: vi.fn() }));

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...args: unknown[]) => unknown) => fn,
}));
vi.mock('@server/users/completeAccountDeletion', () => ({ completeAccountDeletion: h.completeAccountDeletion }));

import { dispatch } from './accountErasure';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), updateMetadata: vi.fn() };
const run = (body: string) =>
  (dispatch as unknown as (event: SQSEvent, context: Context, log: typeof logger) => Promise<void>)(
    { Records: [{ body }] } as SQSEvent,
    {} as Context,
    logger
  );

describe('accountErasure dispatch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('runs the purge for the user in the payload', async () => {
    h.completeAccountDeletion.mockResolvedValue({ deleted: true });
    await run(JSON.stringify({ userId: 'user-1' }));
    expect(h.completeAccountDeletion).toHaveBeenCalledWith('user-1', { logger });
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('deleted'));
  });

  it('logs a skip outcome without throwing', async () => {
    h.completeAccountDeletion.mockResolvedValue({ deleted: false, reason: 'not_found' });
    await expect(run(JSON.stringify({ userId: 'user-1' }))).resolves.toBeUndefined();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('not_found'));
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('throws on a busy account so SQS redelivers', async () => {
    h.completeAccountDeletion.mockResolvedValue({ deleted: false, reason: 'busy' });
    await expect(run(JSON.stringify({ userId: 'user-1' }))).rejects.toThrow('busy');
  });

  it('rethrows a purge error so SQS retries', async () => {
    h.completeAccountDeletion.mockRejectedValue(new Error('boom'));
    await expect(run(JSON.stringify({ userId: 'user-1' }))).rejects.toThrow('boom');
  });

  it.each([['not json'], [JSON.stringify({})], [JSON.stringify({ userId: '' })]])(
    'drops a bad payload (%s) without calling the purge',
    async body => {
      await expect(run(body)).resolves.toBeUndefined();
      expect(h.completeAccountDeletion).not.toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalled();
    }
  );
});
