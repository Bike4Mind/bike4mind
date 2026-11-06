import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@bike4mind/server-utils/queueHandlers/utils', () => ({
  dispatchWithLogger: (fn: (...a: unknown[]) => unknown) => fn,
}));
const dispatchLoopNow = vi.hoisted(() => vi.fn());
vi.mock('../cron/loopScheduler', () => ({ dispatchLoopNow }));

import { handler } from './loopDispatch';

const logger = { warn: vi.fn() };
const run = (...bodies: string[]) =>
  (handler as unknown as (event: unknown, context: unknown, log: unknown) => Promise<void>)(
    { Records: bodies.map(body => ({ body })) },
    {},
    logger
  );

beforeEach(() => vi.clearAllMocks());

describe('loopDispatch handler', () => {
  it('dispatches the named loop', async () => {
    await run(JSON.stringify({ loopId: 'loop-1' }));
    expect(dispatchLoopNow).toHaveBeenCalledWith('loop-1', expect.any(Date), logger);
  });

  it('drops a body that is not JSON or has no loopId, without throwing', async () => {
    await run('not json', JSON.stringify({}));
    expect(dispatchLoopNow).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('throws when the dispatch fails, so SQS retries the message', async () => {
    dispatchLoopNow.mockRejectedValueOnce(new Error('db down'));
    await expect(run(JSON.stringify({ loopId: 'loop-1' }))).rejects.toThrow('db down');
  });
});
