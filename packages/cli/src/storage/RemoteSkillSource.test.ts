import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { RemoteSkillSource } from './RemoteSkillSource.js';
import type { ApiClient } from '../auth/ApiClient.js';

function makeTempCachePath(): string {
  return path.join(os.tmpdir(), `b4m-remote-skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

function makeApiClient(getImpl: ApiClient['get']): ApiClient {
  return { get: getImpl } as unknown as ApiClient;
}

describe('RemoteSkillSource', () => {
  let cachePath: string;

  beforeEach(() => {
    cachePath = makeTempCachePath();
  });

  afterEach(async () => {
    try {
      await fs.unlink(cachePath);
    } catch {
      // best effort
    }
  });

  it('returns an empty list when no skills are available and there is no cache', async () => {
    const get = vi.fn().mockResolvedValue({ data: [] });
    const source = new RemoteSkillSource(makeApiClient(get), { cacheFilePath: cachePath });

    const result = await source.fetchSkills();

    expect(result).toEqual([]);
    expect(get).toHaveBeenCalledWith('/api/skills?limit=100');
  });

  it('maps server skills to CustomCommand shape with source="remote"', async () => {
    const get = vi.fn().mockResolvedValue({
      data: [
        {
          id: 'abc123',
          name: 'summarize',
          description: 'Summarize text',
          body: 'Summarize: $ARGUMENTS',
          argumentHint: '<text>',
          allowedTools: ['Read'],
          disableModelInvocation: false,
        },
      ],
    });
    const source = new RemoteSkillSource(makeApiClient(get), { cacheFilePath: cachePath });

    const result = await source.fetchSkills();

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      name: 'summarize',
      description: 'Summarize text',
      body: 'Summarize: $ARGUMENTS',
      argumentHint: '<text>',
      allowedTools: ['Read'],
      disableModelInvocation: false,
      source: 'remote',
      filePath: 'b4m:/api/skills/abc123',
    });
  });

  it('writes a cache file after a successful fetch', async () => {
    const get = vi.fn().mockResolvedValue({
      data: [{ id: '1', name: 'foo', description: 'd', body: 'b' }],
    });
    const source = new RemoteSkillSource(makeApiClient(get), { cacheFilePath: cachePath });

    await source.fetchSkills();

    const raw = await fs.readFile(cachePath, 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.skills).toHaveLength(1);
    expect(parsed.skills[0].name).toBe('foo');
    expect(typeof parsed.fetchedAt).toBe('string');
  });

  it('serves from cache within the freshness window without a network call', async () => {
    const get = vi.fn().mockResolvedValue({
      data: [{ id: '1', name: 'cached-skill', description: 'd', body: 'b' }],
    });
    const source = new RemoteSkillSource(makeApiClient(get), {
      cacheFilePath: cachePath,
      freshTtlMs: 60_000,
    });

    await source.fetchSkills(); // populates cache
    expect(get).toHaveBeenCalledTimes(1);

    // Second call within TTL - should NOT re-fetch.
    const second = await source.fetchSkills();
    expect(get).toHaveBeenCalledTimes(1);
    expect(second[0]?.name).toBe('cached-skill');
  });

  it('falls back to the cached snapshot when the network fails', async () => {
    // First call seeds the cache via a working fetch.
    const get = vi
      .fn()
      .mockResolvedValueOnce({ data: [{ id: '1', name: 'cached-skill', description: 'd', body: 'b' }] })
      .mockRejectedValueOnce(new Error('network down'));

    const source = new RemoteSkillSource(makeApiClient(get), {
      cacheFilePath: cachePath,
      freshTtlMs: 0, // force re-fetch every call
    });

    await source.fetchSkills(); // seeds cache
    const offline = await source.fetchSkills(); // network fails; cache wins

    expect(get).toHaveBeenCalledTimes(2);
    expect(offline).toHaveLength(1);
    expect(offline[0]?.name).toBe('cached-skill');
  });

  it('returns an empty list when network fails and no cache exists', async () => {
    const get = vi.fn().mockRejectedValue(new Error('no network'));
    const source = new RemoteSkillSource(makeApiClient(get), { cacheFilePath: cachePath });

    const result = await source.fetchSkills();
    expect(result).toEqual([]);
  });

  it('clears the cache when clearCache() is called', async () => {
    const get = vi.fn().mockResolvedValue({ data: [{ id: '1', name: 'foo', description: 'd', body: 'b' }] });
    const source = new RemoteSkillSource(makeApiClient(get), { cacheFilePath: cachePath });

    await source.fetchSkills();
    await expect(fs.access(cachePath)).resolves.not.toThrow();

    await source.clearCache();
    await expect(fs.access(cachePath)).rejects.toThrow();
  });
});
