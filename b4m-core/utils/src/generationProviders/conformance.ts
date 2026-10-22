import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Logger } from '@bike4mind/observability';
import {
  ProviderSubmitError,
  type AsyncGenerationProvider,
  type ProviderContext,
  type ProviderPollResult,
  type SyncGenerationProvider,
} from './types';

export type ConformanceScenario = 'succeeds' | 'blocked' | 'fails' | 'rejects';

/**
 * Every adapter must pass this. `scenario(name)` returns the request (and arms any fixture state the adapter
 * needs, e.g. msw handlers for recorded responses) that drives the provider to that outcome.
 * Test-only: never export from index.ts (it imports vitest).
 */
export type ConformanceSetup<TRequest, TProvider extends AsyncGenerationProvider<string, string, TRequest>> = {
  provider: () => TProvider;
  context?: Partial<ProviderContext>;
  scenario: (name: ConformanceScenario) => Promise<TRequest> | TRequest;
  // Advance whatever clock or fixture state makes the provider report completion.
  settle: () => Promise<void> | void;
  /** Per-test state reset (clocks, msw handlers); runs inside the conformance describe. */
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
};

const pollUntilTerminal = async <TRequest>(
  provider: AsyncGenerationProvider<string, string, TRequest>,
  handle: Awaited<ReturnType<AsyncGenerationProvider<string, string, TRequest>['submit']>>,
  ctx: ProviderContext,
  settle: () => Promise<void> | void
): Promise<ProviderPollResult> => {
  for (let i = 0; i < 10; i++) {
    const result = await provider.poll(handle, ctx);
    if (result.status !== 'running') return result;
    await settle();
  }
  throw new Error('provider never left running within 10 polls');
};

export function describeAsyncProviderConformance<
  TRequest,
  TProvider extends AsyncGenerationProvider<string, string, TRequest>,
>(name: string, setup: ConformanceSetup<TRequest, TProvider>): void {
  const ctx = (): ProviderContext => ({
    apiKey: 'test-key',
    logger: new Logger({ metadata: { conformance: name } }),
    now: () => new Date(),
    signal: new AbortController().signal,
    ...setup.context,
  });

  describe(`${name} conformance`, () => {
    if (setup.beforeEach) beforeEach(setup.beforeEach);
    if (setup.afterEach) afterEach(setup.afterEach);

    it('submits and returns a JSON-serialisable handle tagged with its provider id', async () => {
      const provider = setup.provider();
      const handle = await provider.submit(await setup.scenario('succeeds'), {}, ctx());
      expect(handle.provider).toBe(provider.id);
      expect(JSON.parse(JSON.stringify(handle))).toEqual(handle);
    });

    it('reports succeeded with output that fetchOutput turns into non-empty bytes', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('succeeds'), {}, c);
      const result = await pollUntilTerminal(provider, handle, c, setup.settle);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      const bytes = await provider.fetchOutput(result.output, c);
      expect(bytes.byteLength).toBeGreaterThan(0);
    });

    it('reports a policy block as blocked, not failed', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('blocked'), {}, c);
      expect((await pollUntilTerminal(provider, handle, c, setup.settle)).status).toBe('blocked');
    });

    it('reports a provider failure as a failed value with a retryable flag', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('fails'), {}, c);
      const result = await pollUntilTerminal(provider, handle, c, setup.settle);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(typeof result.retryable).toBe('boolean');
    });

    it('rejects a request the provider refuses with a definitive ProviderSubmitError', async () => {
      const provider = setup.provider();
      const error = await provider.submit(await setup.scenario('rejects'), {}, ctx()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ProviderSubmitError);
      expect((error as ProviderSubmitError).definitive).toBe(true);
    });

    it('reports running on the first poll, so the engine re-poll path is exercised', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('succeeds'), {}, c);
      expect((await provider.poll(handle, c)).status).toBe('running');
    });

    it('gives a failure a non-empty message', async () => {
      const provider = setup.provider();
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('fails'), {}, c);
      const result = await pollUntilTerminal(provider, handle, c, setup.settle);
      expect(result.status).toBe('failed');
      if (result.status === 'failed') expect(result.message.trim().length).toBeGreaterThan(0);
    });

    it('resolves cancel when the provider implements it', async () => {
      const provider = setup.provider();
      if (!provider.cancel) return;
      const c = ctx();
      const handle = await provider.submit(await setup.scenario('succeeds'), {}, c);
      await expect(provider.cancel(handle, c)).resolves.toBeUndefined();
    });
  });
}

export type SyncConformanceScenario = 'succeeds' | 'blocked' | 'fails';

export type SyncConformanceSetup<TRequest, TProvider extends SyncGenerationProvider<string, string, TRequest>> = {
  provider: () => TProvider;
  context?: Partial<ProviderContext>;
  scenario: (name: SyncConformanceScenario) => Promise<TRequest> | TRequest;
  beforeEach?: () => Promise<void> | void;
  afterEach?: () => Promise<void> | void;
};

/** The sync counterpart: one `generate` call returns the terminal result. Test-only, like the async harness. */
export function describeSyncProviderConformance<
  TRequest,
  TProvider extends SyncGenerationProvider<string, string, TRequest>,
>(name: string, setup: SyncConformanceSetup<TRequest, TProvider>): void {
  const ctx = (): ProviderContext => ({
    apiKey: 'test-key',
    logger: new Logger({ metadata: { conformance: name } }),
    now: () => new Date(),
    signal: new AbortController().signal,
    ...setup.context,
  });

  describe(`${name} conformance`, () => {
    if (setup.beforeEach) beforeEach(setup.beforeEach);
    if (setup.afterEach) afterEach(setup.afterEach);

    it('reports succeeded with JSON-serialisable output that fetchOutput turns into non-empty bytes', async () => {
      const provider = setup.provider();
      const c = ctx();
      const result = await provider.generate(await setup.scenario('succeeds'), {}, c);
      expect(result.status).toBe('succeeded');
      if (result.status !== 'succeeded') return;
      expect(JSON.parse(JSON.stringify(result.output))).toEqual(result.output);
      expect((await provider.fetchOutput(result.output, c)).byteLength).toBeGreaterThan(0);
    });

    it('reports a policy block as blocked, not failed', async () => {
      const result = await setup.provider().generate(await setup.scenario('blocked'), {}, ctx());
      expect(result.status).toBe('blocked');
    });

    it('reports a provider failure as a failed value with a retryable flag and a message', async () => {
      const result = await setup.provider().generate(await setup.scenario('fails'), {}, ctx());
      expect(result.status).toBe('failed');
      if (result.status !== 'failed') return;
      expect(typeof result.retryable).toBe('boolean');
      expect(result.message.trim().length).toBeGreaterThan(0);
    });
  });
}
