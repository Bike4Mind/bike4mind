import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createMongoServer } from './createMongoServer';

vi.mock('mongodb-memory-server', () => ({
  MongoMemoryServer: { create: vi.fn() },
}));

const createMock = vi.mocked(MongoMemoryServer.create);
const portInUse = () => new Error('Port "39709" already in use');
// A distinct sentinel so tests assert on identity, not just "a server".
const fakeServer = (id: string) => ({ id }) as unknown as MongoMemoryServer;

describe('createMongoServer', () => {
  // Fake timers so the retry backoffs resolve instantly instead of burning real
  // wall-clock (the exhaustion path sleeps 50+100+150+200ms otherwise).
  beforeEach(() => {
    createMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the instance on first success without retrying', async () => {
    const server = fakeServer('ok');
    createMock.mockResolvedValueOnce(server);

    await expect(createMongoServer()).resolves.toBe(server);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('retries on a port-in-use collision and returns the server that wins the race', async () => {
    const server = fakeServer('after-retry');
    createMock.mockRejectedValueOnce(portInUse()).mockRejectedValueOnce(portInUse()).mockResolvedValueOnce(server);

    const promise = createMongoServer();
    // Drain the chained backoff timers (and the microtasks between them).
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toBe(server);
    expect(createMock).toHaveBeenCalledTimes(3);
  });

  it('does not retry on a non-port error — real failures surface immediately', async () => {
    const bootError = new Error('Instance Failed to start with "DBException in initAndListen"');
    createMock.mockRejectedValueOnce(bootError);

    await expect(createMongoServer()).rejects.toBe(bootError);
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('gives up after the attempt cap and rethrows the last port-in-use error', async () => {
    const lastError = portInUse();
    createMock
      .mockRejectedValueOnce(portInUse())
      .mockRejectedValueOnce(portInUse())
      .mockRejectedValueOnce(portInUse())
      .mockRejectedValueOnce(portInUse())
      .mockRejectedValueOnce(lastError);

    const promise = createMongoServer();
    // Attach a rejection handler before draining timers so the eventual
    // rejection is never an unhandled promise while the backoffs run.
    const assertion = expect(promise).rejects.toBe(lastError);
    await vi.runAllTimersAsync();

    await assertion;
    expect(createMock).toHaveBeenCalledTimes(5);
  });
});
