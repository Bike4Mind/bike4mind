import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions } from './download';
import type { HubGgufBuild, HubGgufFile, HubGgufProjector } from './huggingface';
import {
  importParameters,
  importProjector,
  planSplitImport,
  runSplitImport,
  siblingLayers,
  splitImportBlock,
  splitImportCreateRequest,
  splitImportSpace,
  splitImportStageDir,
  sweepSplitImports,
  type SplitImportPlan,
} from './splitImport';
import type { ModelImportRuntime } from './types';
import { hubBuild, hubDetail } from './__test__/pullFixtures';

const hex = (char: string) => char.repeat(64);

function shard(index: number, sizeBytes: number, overrides: Partial<HubGgufFile> = {}): HubGgufFile {
  const path = `Q8_0/model-Q8_0-0000${index}-of-00003.gguf`;
  return { path, sizeBytes, sha256: hex(String(index)), url: `https://hf.test/${path}`, ...overrides };
}

function splitBuild(overrides: Partial<HubGgufBuild> = {}): HubGgufBuild {
  const files = [shard(1, 300), shard(2, 500), shard(3, 200)];
  return hubBuild({
    id: 'Q8_0/model-Q8_0',
    quant: 'Q8_0',
    label: 'Q8_0',
    files,
    sizeBytes: 1000,
    split: true,
    ollamaRef: null,
    ollamaRefIssue: 'split',
    ...overrides,
  });
}

const projector = (quant: string, sha: string, sizeBytes = 50): HubGgufProjector => ({
  path: `mmproj-${quant}.gguf`,
  sizeBytes,
  sha256: sha,
  url: `https://hf.test/mmproj-${quant}.gguf`,
  quant,
});

describe('splitImportBlock', () => {
  const detail = hubDetail();

  it('passes a complete split build with every checksum and an Ollama-valid name', () => {
    expect(splitImportBlock(detail, splitBuild())).toBeNull();
  });

  it('refuses a split build with shards missing', () => {
    expect(splitImportBlock(detail, splitBuild({ complete: false }))).toBe('incomplete');
  });

  it('refuses names Ollama will not group or create', () => {
    const upper = splitBuild({
      files: [shard(1, 1, { path: 'model-Q8_0-00001-of-00003.GGUF' }), shard(2, 1), shard(3, 1)],
    });
    expect(splitImportBlock(detail, upper)).toBe('unsupported-name');
    expect(splitImportBlock(detail, splitBuild({ label: 'bad tag' }))).toBe('unsupported-name');
    expect(splitImportBlock(hubDetail({ id: 'my.org/repo' }), splitBuild())).toBe('unsupported-name');
  });

  it('refuses a shard name Ollama rejects at create time, and keeps a subfolder', () => {
    const named = (path: string) => splitBuild({ files: [shard(1, 1, { path }), shard(2, 1), shard(3, 1)] });
    for (const path of [
      '..\\..\\x-00001-of-00003.gguf',
      'C:x-00001-of-00003.gguf',
      'Q8_0\\x-00001-of-00003.gguf',
      'a:b/x-00001-of-00003.gguf\\',
    ])
      expect(splitImportBlock(detail, named(path))).toBe('unsupported-name');
    expect(splitImportBlock(detail, named('Q4_K_M/deep/x-00001-of-00003.gguf'))).toBeNull();
  });

  it('tells a hidden checksum on a gated repo from one the Hub never published', () => {
    const masked = splitBuild({ files: [shard(1, 1), shard(2, 1, { sha256: null }), shard(3, 1)] });
    expect(splitImportBlock(hubDetail({ gated: 'manual' }), masked)).toBe('needs-access');
    expect(splitImportBlock(hubDetail(), masked)).toBe('no-checksum');
    expect(splitImportBlock(hubDetail({ canDownload: false }), splitBuild())).toBe('needs-access');
  });
});

describe('importParameters', () => {
  it('keeps the options Ollama reads and drops the rest', () => {
    expect(
      importParameters({
        stop: ['<|im_end|>', 3, ''],
        temperature: 0.6,
        top_k: 20,
        typical_p: 0.9,
        num_ctx: Number.NaN,
        mirostat_tau: 'x',
        template: '{{ .Prompt }}',
      })
    ).toEqual({ stop: ['<|im_end|>'], temperature: 0.6, top_k: 20 });
    expect(importParameters({ stop: '</s>' })).toEqual({ stop: ['</s>'] });
  });

  it('is null for anything but an object with a usable option', () => {
    for (const raw of [null, 'x', [1], {}, { typical_p: 1 }]) expect(importParameters(raw)).toBeNull();
  });
});

describe('importProjector', () => {
  const projectors = [projector('BF16', hex('b')), projector('F16', hex('f')), projector('F32', hex('e'))];

  it('takes the build precision first, then the sibling pairing, then F16', () => {
    expect(importProjector(projectors, 'BF16', hex('e'))?.quant).toBe('BF16');
    expect(importProjector(projectors, 'Q8_0', hex('e'))?.quant).toBe('F32');
    expect(importProjector(projectors, 'Q8_0', null)?.quant).toBe('F16');
    expect(importProjector([projectors[0], projectors[2]], 'Q8_0', null)?.quant).toBe('BF16');
  });

  it('skips a projector without a checksum and is null for a text model', () => {
    expect(importProjector([{ ...projectors[1], sha256: null }, projectors[2]], 'Q8_0', null)?.quant).toBe('F32');
    expect(importProjector([], 'Q8_0', null)).toBeNull();
  });
});

describe('siblingLayers', () => {
  const layers = (projectorSha: string) => ({
    model: hex('9'),
    others: [
      { mediaType: 'application/vnd.ollama.image.template', digest: hex('t') },
      { mediaType: 'application/vnd.ollama.image.projector', digest: projectorSha },
      { mediaType: 'application/vnd.ollama.image.params', digest: hex('p') },
    ],
  });

  it('reads the projector and params of a sibling of the same kind', async () => {
    const hub = {
      ollamaLayers: vi.fn(async (_repo: string, tag: string) => layers(tag.startsWith('UD-') ? hex('b') : hex('f'))),
      ollamaRegistryJson: vi.fn(async () => ({ stop: ['<|im_end|>'], temperature: 0.6, typical_p: 0.7 })),
    };
    const detail = hubDetail({
      builds: [
        hubBuild({ label: 'Q4_K_M', ollamaRef: 'hf.co/org/repo:Q4_K_M' }),
        hubBuild({ id: 'ud', label: 'UD-Q4_K_XL', ollamaRef: 'hf.co/org/repo:UD-Q4_K_XL' }),
        splitBuild({ label: 'UD-Q8_K_XL' }),
      ],
    });
    expect(await siblingLayers(detail, { label: 'UD-Q8_K_XL' }, hub)).toEqual({
      projectorSha256: hex('b'),
      parameters: { stop: ['<|im_end|>'], temperature: 0.6 },
    });
    expect(hub.ollamaLayers).toHaveBeenCalledWith('org/repo', 'UD-Q4_K_XL', expect.anything());
    expect(hub.ollamaRegistryJson).toHaveBeenCalledWith('org/repo', hex('p'), expect.anything());
    expect((await siblingLayers(detail, { label: 'Q8_0' }, hub)).projectorSha256).toBe(hex('f'));
  });

  it('asks nothing when every build in the repo is split', async () => {
    const hub = { ollamaLayers: vi.fn(), ollamaRegistryJson: vi.fn() };
    expect(await siblingLayers(hubDetail({ builds: [splitBuild()] }), splitBuild(), hub)).toEqual({
      projectorSha256: null,
      parameters: null,
    });
    expect(hub.ollamaLayers).not.toHaveBeenCalled();
  });
});

describe('planSplitImport and its create request', () => {
  it('names each shard by its own file name, then the projector, with params as PARAMETER values', () => {
    const plan = planSplitImport(hubDetail({ projectors: [projector('F16', hex('f'))] }), splitBuild(), {
      projectorSha256: null,
      parameters: { stop: ['</s>'], temperature: 0.6 },
    });
    expect(plan.model).toBe('hf.co/org/repo:Q8_0');
    expect(plan.totalBytes).toBe(1050);
    expect(splitImportCreateRequest(plan)).toEqual({
      model: 'hf.co/org/repo:Q8_0',
      files: {
        'model-Q8_0-00001-of-00003.gguf': `sha256:${hex('1')}`,
        'model-Q8_0-00002-of-00003.gguf': `sha256:${hex('2')}`,
        'model-Q8_0-00003-of-00003.gguf': `sha256:${hex('3')}`,
        'mmproj-F16.gguf': `sha256:${hex('f')}`,
      },
      parameters: { stop: ['</s>'], temperature: 0.6 },
    });
    expect(Object.keys(splitImportCreateRequest(plan).files)[0]).toBe('model-Q8_0-00001-of-00003.gguf');
  });

  it('sends no projector or parameters for a text model without a sibling', () => {
    const plan = planSplitImport(hubDetail(), splitBuild(), { projectorSha256: null, parameters: null });
    const request = splitImportCreateRequest(plan);
    expect(Object.keys(request.files)).toEqual([
      'model-Q8_0-00001-of-00003.gguf',
      'model-Q8_0-00002-of-00003.gguf',
      'model-Q8_0-00003-of-00003.gguf',
    ]);
    expect(request).not.toHaveProperty('parameters');
  });

  it('refuses to plan a single-file build', () => {
    expect(() => planSplitImport(hubDetail(), hubBuild(), { projectorSha256: null, parameters: null })).toThrow(
      /not a split build/
    );
  });
});

describe('splitImportSpace', () => {
  const plan = planSplitImport(hubDetail(), splitBuild(), { projectorSha256: null, parameters: null });
  const none = new Set<string>();

  it('needs every part plus the largest staged one on a single disk', () => {
    expect(splitImportSpace(plan, none, { stagingFreeBytes: 1500, storeFreeBytes: 1500, sameDisk: true })).toEqual({
      ok: true,
    });
    expect(splitImportSpace(plan, none, { stagingFreeBytes: 1499, storeFreeBytes: 1499, sameDisk: true })).toEqual({
      ok: false,
      where: 'store',
      neededBytes: 1500,
      freeBytes: 1499,
    });
  });

  it('counts one disk when it cannot tell', () => {
    expect(splitImportSpace(plan, none, { stagingFreeBytes: 1200, storeFreeBytes: null, sameDisk: null })).toEqual({
      ok: false,
      where: 'staging',
      neededBytes: 1500,
      freeBytes: 1200,
    });
  });

  it('needs the largest part for staging and every part in Ollama on two disks', () => {
    const two = (staging: number, store: number) =>
      splitImportSpace(plan, none, { stagingFreeBytes: staging, storeFreeBytes: store, sameDisk: false });
    expect(two(500, 1000)).toEqual({ ok: true });
    expect(two(499, 1000)).toMatchObject({ ok: false, where: 'staging', neededBytes: 500 });
    expect(two(500, 999)).toMatchObject({ ok: false, where: 'store', neededBytes: 1000 });
  });

  it('leaves out the parts Ollama already holds', () => {
    const present = new Set([`sha256:${hex('2')}`]);
    expect(splitImportSpace(plan, present, { stagingFreeBytes: 800, storeFreeBytes: 800, sameDisk: true })).toEqual({
      ok: true,
    });
    expect(
      splitImportSpace(plan, present, { stagingFreeBytes: 799, storeFreeBytes: 799, sameDisk: true })
    ).toMatchObject({ ok: false, neededBytes: 800 });
  });

  it('passes when no free space can be read', () => {
    expect(splitImportSpace(plan, none, { stagingFreeBytes: null, storeFreeBytes: null, sameDisk: true })).toEqual({
      ok: true,
    });
  });
});

describe('runSplitImport', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'split-import-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const plan = (): SplitImportPlan =>
    planSplitImport(hubDetail({ projectors: [projector('F16', hex('f'))] }), splitBuild(), {
      projectorSha256: null,
      parameters: { temperature: 0.6 },
    });

  function fakes(options: { present?: string[]; failUpload?: string; failCreate?: boolean } = {}) {
    const events: string[] = [];
    const hub = {
      download: vi.fn(async (file: HubGgufFile, destination: string, opts?: DownloadOptions) => {
        const staged = (await readdir(join(destination, '..'))).filter(name => name.endsWith('.gguf'));
        events.push(`download ${file.path.split('/').pop()} with ${staged.length} staged`);
        opts?.onProgress?.({ status: 'downloading', completedBytes: file.sizeBytes, totalBytes: file.sizeBytes });
        await writeFile(destination, 'x');
        return { path: destination, sizeBytes: file.sizeBytes, sha256: file.sha256, resumedBytes: 0 };
      }),
    };
    const runtime = {
      hasBlob: vi.fn(async (digest: string) => options.present?.includes(digest) ?? false),
      uploadBlob: vi.fn(async (digest: string, path: string, opts?: { onProgress?: (sent: number) => void }) => {
        await stat(path);
        if (digest === options.failUpload) throw new Error('upload refused');
        events.push(`upload ${path.split('/').pop()}`);
        opts?.onProgress?.(1);
      }),
      create: vi.fn(async () => {
        events.push('create');
        if (options.failCreate) throw new Error('invalid split GGUF');
      }),
    } satisfies ModelImportRuntime;
    return { events, hub, runtime };
  }

  it('moves one part at a time into Ollama, skips what it holds, then creates the model', async () => {
    const { events, hub, runtime } = fakes({ present: [`sha256:${hex('2')}`] });
    const dir = join(root, 'run');
    const progress: string[] = [];
    await runSplitImport(plan(), {
      hub,
      runtime,
      dir,
      onProgress: update => progress.push(`${update.status} ${update.completedBytes}/${update.totalBytes}`),
    });
    expect(events).toEqual([
      'download model-Q8_0-00001-of-00003.gguf with 0 staged',
      'upload model-Q8_0-00001-of-00003.gguf',
      'download model-Q8_0-00003-of-00003.gguf with 0 staged',
      'upload model-Q8_0-00003-of-00003.gguf',
      'download mmproj-F16.gguf with 0 staged',
      'upload mmproj-F16.gguf',
      'create',
    ]);
    expect(runtime.create).toHaveBeenCalledWith(splitImportCreateRequest(plan()), expect.anything());
    expect(progress.slice(0, 3)).toEqual(['downloading 0/1050', 'downloading 150/1050', 'downloading 150/1050']);
    expect(progress.at(-1)).toBe('creating 1050/1050');
    const numbers = progress.map(line => Number(line.split(' ')[1]?.split('/')[0]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    await expect(stat(dir)).rejects.toThrow();
  });

  it('keeps its folder and creates nothing when a part fails', async () => {
    const { hub, runtime } = fakes({ failUpload: `sha256:${hex('2')}` });
    const dir = join(root, 'run');
    await expect(runSplitImport(plan(), { hub, runtime, dir })).rejects.toThrow('upload refused');
    expect(runtime.create).not.toHaveBeenCalled();
    await expect(stat(dir)).resolves.toBeDefined();
  });

  it('keeps its folder when Ollama refuses the create', async () => {
    const { hub, runtime } = fakes({ failCreate: true });
    const dir = join(root, 'run');
    await expect(runSplitImport(plan(), { hub, runtime, dir })).rejects.toThrow('invalid split GGUF');
    await expect(stat(dir)).resolves.toBeDefined();
  });

  it('leaves a partial download in place so the next run resumes it', async () => {
    const { runtime } = fakes();
    const controller = new AbortController();
    const dir = splitImportStageDir(root, plan());
    const seen: string[] = [];
    const hub = {
      download: vi.fn(async (file: HubGgufFile, destination: string) => {
        seen.push(destination);
        if (seen.length === 1) {
          await writeFile(`${destination}.partial`, 'half');
          controller.abort();
          throw new DOMException('aborted', 'AbortError');
        }
        if (seen.length === 2) expect(await readdir(dir)).toContain(`${basename(destination)}.partial`);
        await writeFile(destination, 'x');
        return { path: destination, sizeBytes: file.sizeBytes, sha256: file.sha256, resumedBytes: 4 };
      }),
    };
    await expect(runSplitImport(plan(), { hub, runtime, dir, signal: controller.signal })).rejects.toThrow('aborted');
    expect(runtime.uploadBlob).not.toHaveBeenCalled();
    expect(splitImportStageDir(root, plan())).toBe(dir);
    await runSplitImport(plan(), { hub, runtime, dir });
    expect(seen[1]).toBe(seen[0]);
    await expect(stat(dir)).rejects.toThrow();
  });

  it('keys the staging folder to the repo, revision and file set', () => {
    const base = plan();
    const moved = plan();
    moved.parts[0] = { ...moved.parts[0], file: { ...moved.parts[0].file, url: 'https://hf.test/other-revision' } };
    expect(splitImportStageDir(root, base)).toBe(splitImportStageDir(root, plan()));
    expect(splitImportStageDir(root, moved)).not.toBe(splitImportStageDir(root, base));
  });

  it('refuses a bad name before downloading anything', async () => {
    const { hub, runtime } = fakes();
    const bad = plan();
    bad.parts[2] = { ...bad.parts[2], name: '..\\..\\x-00003-of-00003.gguf' };
    await expect(runSplitImport(bad, { hub, runtime, dir: join(root, 'run') })).rejects.toThrow(/cannot be imported/);
    expect(hub.download).not.toHaveBeenCalled();
  });
});

describe('sweepSplitImports', () => {
  it('removes staging folders untouched for longer than the age limit and keeps recent ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'split-sweep-'));
    try {
      const old = join(root, 'build-old');
      const recent = join(root, 'build-recent');
      for (const dir of [old, recent]) await mkdir(dir, { recursive: true });
      await writeFile(join(old, 'part.partial'), 'x');
      await writeFile(join(recent, 'part.partial'), 'x');
      const week = 7 * 24 * 60 * 60 * 1000;
      const aged = new Date(Date.now() - 2 * week);
      for (const path of [join(old, 'part.partial'), old]) await utimes(path, aged, aged);
      await sweepSplitImports(root, week);
      expect((await readdir(root)).sort()).toEqual(['build-recent']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does nothing for a folder that does not exist yet', async () => {
    await expect(sweepSplitImports(join(tmpdir(), 'split-sweep-missing'))).resolves.toBeUndefined();
  });
});
