/**
 * T8: the startup leg respects the driver-env gate and the staleness gate.
 * Both are load-bearing - the env gate is what keeps every preview stage (whose
 * fresh database always passes the staleness gate) from fanning out to every
 * provider on first boot.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from '@bike4mind/observability';

const { runModelDiscovery, lastSuccessfulRun, sourceFactories } = vi.hoisted(() => {
  const stub = (name: string) => () => ({ name, kind: 'provider', isConfigured: () => false, fetch: async () => ({}) });
  return {
    runModelDiscovery: vi.fn(async () => ({ outcome: 'ok' })),
    lastSuccessfulRun: vi.fn(),
    sourceFactories: {
      createOpenAiSource: stub('openai'),
      createAnthropicSource: stub('anthropic'),
      createXaiSource: stub('xai'),
      createKimiSource: stub('kimi'),
      createGeminiSource: stub('gemini'),
      createOllamaSource: stub('ollama'),
      createBflSource: stub('bfl'),
      createElevenLabsSource: stub('elevenlabs'),
      createBedrockSource: stub('bedrock'),
      createModelsDevSource: stub('models.dev'),
      createLiteLlmSource: stub('litellm'),
    },
  };
});

vi.mock('@bike4mind/database', () => ({
  MODEL_ID_ALIASES: {},
  whenCatalogSeeded: async () => {},
  modelDiscoveryRunRepository: { lastSuccessfulRun },
  modelCatalogRepository: { rowsInForce: vi.fn(async () => []) },
  modelPriceRepository: {},
  modelDiscoveryStateRepository: {},
  cacheRepository: {},
  adminSettingsRepository: {},
  apiKeyRepository: {},
}));
vi.mock('@bike4mind/services', () => ({
  modelDiscoveryService: { runModelDiscovery, getDiscoveryCredentials: vi.fn(), ...sourceFactories },
}));

const { DISCOVERY_DRIVER_ENV, isDiscoveryDriver, runDiscoveryOnStartup, startDiscoveryOnStartup } =
  await import('./startupLeg');

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
const NOW = new Date('2026-07-26T12:00:00Z');
const at = (iso: string) => ({ startedAt: new Date(iso) });

beforeEach(() => {
  process.env[DISCOVERY_DRIVER_ENV] = 'true';
  lastSuccessfulRun.mockResolvedValue(null);
});

afterEach(() => {
  delete process.env[DISCOVERY_DRIVER_ENV];
  delete process.env.B4M_SELF_HOST;
  vi.clearAllMocks();
});

describe('the driver-env gate', () => {
  // server/worker/main.ts registers the recurring discovery task only when this
  // is true, so an unflagged self-host schedules nothing and reaches no network.
  it('answers no for an unset or non-"true" flag, and yes only for "true"', () => {
    expect(isDiscoveryDriver()).toBe(true);
    process.env[DISCOVERY_DRIVER_ENV] = '1';
    expect(isDiscoveryDriver()).toBe(false);
    delete process.env[DISCOVERY_DRIVER_ENV];
    expect(isDiscoveryDriver()).toBe(false);
    process.env.B4M_SELF_HOST = 'true';
    expect(isDiscoveryDriver()).toBe(false);
  });

  it('does nothing when B4M_DISCOVERY_DRIVER is unset', async () => {
    delete process.env[DISCOVERY_DRIVER_ENV];
    await expect(runDiscoveryOnStartup({ logger, now: () => NOW })).resolves.toBe('not-a-driver');
    expect(lastSuccessfulRun).not.toHaveBeenCalled();
    expect(runModelDiscovery).not.toHaveBeenCalled();
  });

  it('does nothing when it is set to anything but "true"', async () => {
    process.env[DISCOVERY_DRIVER_ENV] = '1';
    await expect(runDiscoveryOnStartup({ logger, now: () => NOW })).resolves.toBe('not-a-driver');
    expect(runModelDiscovery).not.toHaveBeenCalled();
  });

  it('is not B4M_SELF_HOST: a self-host process that is not a driver stays quiet', async () => {
    delete process.env[DISCOVERY_DRIVER_ENV];
    process.env.B4M_SELF_HOST = 'true';
    await expect(runDiscoveryOnStartup({ logger, now: () => NOW })).resolves.toBe('not-a-driver');
    expect(runModelDiscovery).not.toHaveBeenCalled();
  });
});

describe('the staleness gate', () => {
  it('runs when no successful run exists (fresh boot)', async () => {
    await expect(runDiscoveryOnStartup({ logger, now: () => NOW })).resolves.toBe('ran');
    expect(runModelDiscovery).toHaveBeenCalledTimes(1);
    expect(runModelDiscovery.mock.calls[0][1]).toMatchObject({ trigger: 'startup' });
  });

  it('runs when the last successful run is older than the interval', async () => {
    lastSuccessfulRun.mockResolvedValue(at('2026-07-26T05:00:00Z'));
    await expect(runDiscoveryOnStartup({ logger, now: () => NOW })).resolves.toBe('ran');
    expect(runModelDiscovery).toHaveBeenCalledTimes(1);
  });

  it('declines when a successful run is inside the interval', async () => {
    lastSuccessfulRun.mockResolvedValue(at('2026-07-26T09:00:00Z'));
    await expect(runDiscoveryOnStartup({ logger, now: () => NOW })).resolves.toBe('recently-run');
    expect(runModelDiscovery).not.toHaveBeenCalled();
  });

  it('honors an explicit interval override', async () => {
    lastSuccessfulRun.mockResolvedValue(at('2026-07-26T11:30:00Z'));
    await expect(runDiscoveryOnStartup({ logger, intervalMs: 60_000, now: () => NOW })).resolves.toBe('ran');
  });

  it('asks for the newest successful run on any host', async () => {
    await runDiscoveryOnStartup({ logger, now: () => NOW });
    // A hosted cron run leaves the catalog just as fresh as a worker run.
    expect(lastSuccessfulRun).toHaveBeenCalledWith();
  });
});

describe('run labelling', () => {
  it('defaults the host to the deployment flag, not the driver flag', async () => {
    process.env.B4M_SELF_HOST = 'true';
    await runDiscoveryOnStartup({ logger, now: () => NOW });
    expect(runModelDiscovery.mock.calls[0][1]).toMatchObject({ host: 'selfhost' });
  });

  it('labels a non-self-host driver process hosted', async () => {
    await runDiscoveryOnStartup({ logger, now: () => NOW });
    expect(runModelDiscovery.mock.calls[0][1]).toMatchObject({ host: 'hosted' });
  });

  it('honors an explicit host', async () => {
    await runDiscoveryOnStartup({ logger, host: 'selfhost', now: () => NOW });
    expect(runModelDiscovery.mock.calls[0][1]).toMatchObject({ host: 'selfhost' });
  });
});

describe('fire-and-forget wrapper', () => {
  it('swallows a failed run into a log line', async () => {
    runModelDiscovery.mockRejectedValueOnce(new Error('provider exploded'));
    await startDiscoveryOnStartup({ logger, now: () => NOW });
    expect(logger.error).toHaveBeenCalled();
  });

  it('returns a promise that settles with the run, so shutdown can wait for it', async () => {
    let finishRun: (() => void) | undefined;
    runModelDiscovery.mockImplementationOnce(
      () => new Promise(resolve => (finishRun = () => resolve({ outcome: 'ok' })))
    );

    let settled = false;
    const leg = startDiscoveryOnStartup({ logger, now: () => NOW }).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(runModelDiscovery).toHaveBeenCalled());
    expect(settled).toBe(false);

    finishRun?.();
    await leg;
    expect(settled).toBe(true);
  });
});
