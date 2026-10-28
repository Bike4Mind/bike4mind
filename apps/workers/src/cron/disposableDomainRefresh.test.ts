import { afterEach, describe, expect, it, vi } from 'vitest';

const { repo, emitMetrics } = vi.hoisted(() => ({
  repo: {
    getDisposableSourceStatus: vi.fn(),
    replaceDisposableSource: vi.fn(),
    recordDisposableSource: vi.fn(),
  },
  emitMetrics: vi.fn(),
}));

vi.mock('sst', () => ({ Resource: { App: { stage: 'test' } } }));
vi.mock('@bike4mind/db-core', () => ({ connectDB: vi.fn() }));
vi.mock('@bike4mind/database', () => {
  const model = { createIndexes: vi.fn() };
  return {
    disposableDomainRepository: repo,
    DisposableDomainModel: model,
    DisposableDomainSourceModel: model,
    DomainIntelligenceModel: model,
  };
});
vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { MONGODB_URI: 'mongodb://%STAGE%' } }));
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetrics }));
vi.mock('@bike4mind/services', () => ({ userService: { PUBLIC_MAILBOX_DOMAINS: new Set(['gmail.com']) } }));

import { DISPOSABLE_LIST_SOURCES, handler, parseDisposableList, rejectSnapshot } from './disposableDomainRefresh';

describe('parseDisposableList', () => {
  it('keeps listed domains as published and drops comments, suffixes and mailbox providers', () => {
    const text = [
      '# Fake and Temp Mail Providers',
      'Example-Burner.TEST',
      '  sub.example-burner.test  ',
      'x.github.io',
      'github.io',
      'co.uk',
      'gmail.com',
      'not a domain',
      '',
    ].join('\n');
    expect([...parseDisposableList(text)].sort()).toEqual([
      'example-burner.test',
      'sub.example-burner.test',
      'x.github.io',
    ]);
  });
});

describe('rejectSnapshot', () => {
  it('refuses empty or truncated snapshots and accepts normal drift', () => {
    expect(rejectSnapshot(0, undefined)).toMatch(/empty/i);
    expect(rejectSnapshot(499, 1000)).toMatch(/under half/);
    expect(rejectSnapshot(500, 1000)).toBeNull();
    expect(rejectSnapshot(10, undefined)).toBeNull();
  });
});

describe('handler', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps a failing source untouched, refreshes the others and reports the failure', async () => {
    repo.getDisposableSourceStatus.mockResolvedValue([{ source: 'curated', count: 1000 }]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === DISPOSABLE_LIST_SOURCES.aggregate
          ? new Response('down', { status: 503 })
          : new Response('one-burner.test\ntwo-burner.test\n')
      )
    );
    const result = await handler();

    expect(result.status).toBe('partial');
    expect(repo.replaceDisposableSource).toHaveBeenCalledTimes(1);
    expect(repo.replaceDisposableSource).toHaveBeenCalledWith('fakefilter', expect.any(Set), expect.any(Date));
    expect(repo.recordDisposableSource).toHaveBeenCalledWith(
      'aggregate',
      expect.objectContaining({ error: 'HTTP 503' })
    );
    // Two entries against a previous 1000 is a truncated snapshot, not a refresh.
    expect(repo.recordDisposableSource).toHaveBeenCalledWith(
      'curated',
      expect.objectContaining({ error: expect.stringMatching(/under half/) })
    );
    expect(repo.recordDisposableSource).toHaveBeenCalledWith('fakefilter', expect.objectContaining({ count: 2 }));
    expect(emitMetrics).toHaveBeenCalledWith('Lumina5/DisposableDomains', [
      { name: 'SourceFailures', value: 2, dimensions: { Stage: 'test' } },
    ]);
  });

  it('still refreshes later sources when recording a failure throws', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    repo.getDisposableSourceStatus.mockResolvedValue([]);
    repo.replaceDisposableSource.mockClear();
    repo.recordDisposableSource.mockImplementation(async (_source: string, update: { error?: string }) => {
      if (update.error) throw new Error('db down');
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url === DISPOSABLE_LIST_SOURCES.aggregate ? new Response('down', { status: 503 }) : new Response('a.test')
      )
    );
    const result = await handler();

    expect(result.status).toBe('partial');
    expect(repo.replaceDisposableSource).toHaveBeenCalledTimes(2);
  });
});
