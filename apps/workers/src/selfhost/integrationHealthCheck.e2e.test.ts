import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import type { Logger } from '@bike4mind/observability';
import {
  IntegrationHealthCheck,
  integrationHealthCheckRepository,
  INTEGRATION_HEALTH_INTEGRATIONS,
} from '@bike4mind/database';
import { emitMetrics } from '@bike4mind/server-utils/utils/cloudwatch';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { SelfHostWorker } from './selfHostWorker';
import { INTEGRATION_HEALTH_CHECK_INTERVAL_MS, registerIntegrationHealthCheck } from './integrationHealthCheck';

vi.mock('sst', () => ({ Resource: { App: { stage: 'selfhost' } } }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'unused' } }));
vi.mock('@bike4mind/server-utils/utils/sqs', () => ({ receiveFromQueue: vi.fn(), deleteFromQueue: vi.fn() }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: vi.fn(), emitMetrics: vi.fn() }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

// Above vi.waitFor's 1s default so a loaded host running the whole lane cannot fail a correct tick.
const SETTLE_WAIT = { timeout: 10_000 };
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
let server: MongoMemoryServer;
const workers: SelfHostWorker[] = [];

/** Answers each probe host from `answers`, defaulting to a reachable 200. */
function stubFetch(answers: Record<string, number | 'reject'> = {}): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const answer = answers[new URL(String(input)).host] ?? 200;
      if (answer === 'reject') throw new Error('ECONNREFUSED');
      return new Response(JSON.stringify({ ok: true }), { status: answer });
    })
  );
}

function startWorker(): SelfHostWorker {
  // Before start(): the interval is armed with whatever setInterval is live at that moment.
  // Only the interval clock is faked, so the Mongo driver and vi.waitFor keep their real timers.
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  const worker = new SelfHostWorker(logger);
  workers.push(worker);
  registerIntegrationHealthCheck(worker, logger);
  worker.start();
  return worker;
}

async function tick(): Promise<void> {
  await vi.advanceTimersByTimeAsync(INTEGRATION_HEALTH_CHECK_INTERVAL_MS);
}

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.stop(1000);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.mocked(emitMetrics).mockClear();
  // Not dropDatabase: mongoose reads a heartbeat stamped under the fake clock as a stale
  // connection once real time returns, and that call then buffers until it times out.
  await IntegrationHealthCheck.collection.deleteMany({});
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

describe('self-host integration health check against Mongo', () => {
  it('persists one check per integration on a tick, with no CloudWatch call', async () => {
    stubFetch();
    startWorker();
    await tick();

    await vi.waitFor(async () => {
      expect(await IntegrationHealthCheck.collection.countDocuments({})).toBe(INTEGRATION_HEALTH_INTEGRATIONS.length);
    }, SETTLE_WAIT);

    for (const integration of INTEGRATION_HEALTH_INTEGRATIONS) {
      const recent = await integrationHealthCheckRepository.getRecentByIntegration(integration, 1);
      expect(recent).toHaveLength(1);
      expect(recent[0]).toMatchObject({ integration, status: 'healthy', statusCode: 200, error: null });
      expect(recent[0].latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(emitMetrics).not.toHaveBeenCalled();
  });

  it('records the unreachable integration and still records the other three', async () => {
    stubFetch({ 'api.github.com': 'reject' });
    startWorker();
    await tick();

    await vi.waitFor(async () => {
      expect(await IntegrationHealthCheck.collection.countDocuments({})).toBe(INTEGRATION_HEALTH_INTEGRATIONS.length);
    }, SETTLE_WAIT);

    const [github] = await integrationHealthCheckRepository.getRecentByIntegration('github', 1);
    expect(github).toMatchObject({ integration: 'github', status: 'unhealthy', statusCode: null });
    expect(github.error).toMatch(/ECONNREFUSED/);

    for (const integration of ['slack', 'jira', 'confluence'] as const) {
      const [check] = await integrationHealthCheckRepository.getRecentByIntegration(integration, 1);
      expect(check).toMatchObject({ integration, status: 'healthy', statusCode: 200 });
    }
    expect(emitMetrics).not.toHaveBeenCalled();
  });
});
