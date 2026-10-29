import { describe, expect, it, vi } from 'vitest';
import type { HubGgufBuild, HubModelDetail } from '@bike4mind/local-models';
import { planPull, requireUnchangedLicenses, type HubClient, type ModelSourceDeps } from './localModels.js';

const build: HubGgufBuild = {
  id: 'model-Q4_K_M',
  quant: 'Q4_K_M',
  label: 'Q4_K_M',
  files: [],
  sizeBytes: 1024,
  split: false,
  complete: true,
  ollamaRef: 'hf.co/org/repo:Q4_K_M',
  ollamaRefIssue: null,
};

const detail = (overrides: Partial<HubModelDetail> = {}): HubModelDetail => ({
  id: 'org/repo',
  author: 'org',
  downloads: null,
  likes: null,
  updatedAt: null,
  pipelineTag: null,
  gated: false,
  private: false,
  licenses: ['apache-2.0'],
  baseModels: [],
  tags: [],
  revision: 'abc',
  licenseName: null,
  licenseLink: null,
  gguf: null,
  builds: [build],
  projectors: [],
  canDownload: true,
  ollamaNeedsSshKey: false,
  ...overrides,
});

const hubWith = (getModel: (...args: unknown[]) => Promise<HubModelDetail>): HubClient =>
  ({ endpoint: 'https://huggingface.co', getModel }) as unknown as HubClient;

describe('planPull', () => {
  it('re-reads a gated repo uncached before refusing it, so a fresh access grant is seen', async () => {
    const getModel = vi.fn(async (_repo: unknown, options: unknown) =>
      (options as { refresh?: boolean }).refresh
        ? detail({ gated: 'manual', canDownload: true })
        : detail({ gated: 'manual', canDownload: false })
    );
    const deps = {
      hub: () => hubWith(getModel),
      resolveRuntime: async () => ({ runtime: { capabilities: { canPull: true } }, source: 'ollama' }),
      signal: new AbortController().signal,
    } as unknown as ModelSourceDeps;

    const plan = await planPull('hf.co/org/repo:Q4_K_M', deps);

    expect(plan.kind).toBe('hub');
    expect(getModel).toHaveBeenCalledTimes(2);
    expect(getModel.mock.calls[1][1]).toMatchObject({ refresh: true });
  });

  it('still refuses a gated repo when the uncached read agrees', async () => {
    const getModel = vi.fn(async () => detail({ gated: 'manual', canDownload: false }));
    const deps = { hub: () => hubWith(getModel), signal: new AbortController().signal } as unknown as ModelSourceDeps;

    await expect(planPull('hf.co/org/repo:Q4_K_M', deps)).rejects.toThrow(/org\/repo/);
    expect(getModel).toHaveBeenCalledTimes(2);
  });
});

describe('requireUnchangedLicenses', () => {
  it('re-reads the repo uncached', async () => {
    const getModel = vi.fn(async () => detail());
    const hub = hubWith(getModel);
    const shown = { label: 'apache-2.0', link: 'https://huggingface.co/org/repo' };

    await requireUnchangedLicenses(hub, detail(), shown, new AbortController().signal);

    expect(getModel).toHaveBeenCalledWith('org/repo', expect.objectContaining({ refresh: true }));
  });
});
