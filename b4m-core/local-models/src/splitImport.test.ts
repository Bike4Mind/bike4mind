import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadOptions } from './download';
import { ModelFileBusyError, ModelFileConflictError } from './errors';
import type { HubGgufBuild, HubGgufFile, HubGgufProjector } from './huggingface';
import {
  createFileNameProblem,
  importParameters,
  importProjector,
  planSplitImport,
  removeSplitStaging,
  runSplitImport,
  siblingLayers,
  splitImportBlock,
  splitImportCreateRequest,
  splitImportSpace,
  splitPartPath,
  stagedPartBytes,
  stagedPath,
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

  it('counts bytes already staged as progress, not as missing room', () => {
    const staged = new Map([
      [`sha256:${hex('1')}`, 300],
      [`sha256:${hex('2')}`, 100],
    ]);
    const one = (free: number) =>
      splitImportSpace(plan, none, { stagingFreeBytes: free, storeFreeBytes: free, sameDisk: true }, staged);
    expect(one(1100)).toEqual({ ok: true });
    expect(one(1099)).toMatchObject({ ok: false, neededBytes: 1100 });
    const two = (staging: number, store: number) =>
      splitImportSpace(plan, none, { stagingFreeBytes: staging, storeFreeBytes: store, sameDisk: false }, staged);
    expect(two(400, 1000)).toEqual({ ok: true });
    expect(two(399, 1000)).toMatchObject({ ok: false, where: 'staging', neededBytes: 400 });
    expect(two(400, 999)).toMatchObject({ ok: false, where: 'store', neededBytes: 1000 });
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
      `upload ${hex('1')}.gguf`,
      'download model-Q8_0-00003-of-00003.gguf with 0 staged',
      `upload ${hex('3')}.gguf`,
      'download mmproj-F16.gguf with 0 staged',
      `upload ${hex('f')}.gguf`,
      'create',
    ]);
    expect(runtime.create).toHaveBeenCalledWith(splitImportCreateRequest(plan()), expect.anything());
    expect(progress.slice(0, 3)).toEqual(['downloading 0/1050', 'downloading 150/1050', 'downloading 150/1050']);
    expect(progress.at(-1)).toBe('creating 1050/1050');
    const numbers = progress.map(line => Number(line.split(' ')[1]?.split('/')[0]));
    expect(numbers).toEqual([...numbers].sort((a, b) => a - b));
    expect(await readdir(dir)).toEqual([]);
  });

  it('leaves a part another import needs when its own create succeeds', async () => {
    const { hub, runtime } = fakes();
    const dir = join(root, 'run');
    const shared = `sha256:${hex('f')}`;
    runtime.create.mockImplementationOnce(async () => {
      await writeFile(join(dir, `${hex('f')}.gguf.partial`), 'x');
      await writeFile(join(dir, `${hex('f')}.gguf.lock`), 'x');
      await writeFile(join(dir, `${hex('1')}.gguf.lock`), 'x');
    });
    await runSplitImport(plan(), { hub, runtime, dir, keep: () => new Set([shared]) });
    expect((await readdir(dir)).sort()).toEqual([`${hex('f')}.gguf.lock`, `${hex('f')}.gguf.partial`]);
  });

  it('waits for a part another import is downloading and skips it once Ollama has it', async () => {
    const { events, hub, runtime } = fakes();
    const shared = `sha256:${hex('f')}`;
    let sharedDone = false;
    runtime.hasBlob.mockImplementation(async (digest: string) => digest === shared && sharedDone);
    const download = hub.download.getMockImplementation();
    hub.download.mockImplementation(async (file: HubGgufFile, destination: string, opts?: DownloadOptions) => {
      if (file.sha256 !== hex('f')) return download!(file, destination, opts);
      sharedDone = true;
      throw new ModelFileBusyError('ollama', destination, 123);
    });
    await runSplitImport(plan(), { hub, runtime, dir: join(root, 'run') });
    expect(events.filter(event => event.includes('mmproj') || event.includes(hex('f')))).toEqual([]);
    expect(hub.download.mock.calls.filter(([file]) => file.sha256 === hex('f'))).toHaveLength(1);
    expect(runtime.create).toHaveBeenCalled();
  });

  it('downloads a busy part itself once the lock is free and Ollama still lacks it', async () => {
    const { hub, runtime } = fakes();
    const download = hub.download.getMockImplementation();
    let busy = 2;
    hub.download.mockImplementation(async (file: HubGgufFile, destination: string, opts?: DownloadOptions) => {
      if (file.sha256 === hex('f') && busy-- > 0) throw new ModelFileBusyError('ollama', destination, null);
      return download!(file, destination, opts);
    });
    await runSplitImport(plan(), { hub, runtime, dir: join(root, 'run') });
    expect(runtime.uploadBlob).toHaveBeenCalledWith(`sha256:${hex('f')}`, expect.anything(), expect.anything());
  });

  it('still creates the model when another import hands the downloaded part to Ollama and deletes it', async () => {
    const { hub, runtime } = fakes();
    const shared = `sha256:${hex('f')}`;
    let sharedDone = false;
    runtime.hasBlob.mockImplementation(async (digest: string) => digest === shared && sharedDone);
    const download = hub.download.getMockImplementation();
    hub.download.mockImplementation(async (file: HubGgufFile, destination: string, opts?: DownloadOptions) => {
      const result = await download!(file, destination, opts);
      if (file.sha256 === hex('f')) {
        sharedDone = true;
        await rm(destination, { force: true });
      }
      return result;
    });
    await runSplitImport(plan(), { hub, runtime, dir: join(root, 'run') });
    expect(runtime.uploadBlob).not.toHaveBeenCalledWith(shared, expect.anything(), expect.anything());
    expect(runtime.create).toHaveBeenCalled();
  });

  it('treats a part as held when its upload fails because another import removed the file first', async () => {
    const { hub, runtime } = fakes();
    const shared = `sha256:${hex('f')}`;
    let sharedDone = false;
    runtime.hasBlob.mockImplementation(async (digest: string) => digest === shared && sharedDone);
    runtime.uploadBlob.mockImplementation(async (digest: string, path: string) => {
      if (digest !== shared) return;
      sharedDone = true;
      await stat(`${path}.gone`);
    });
    await runSplitImport(plan(), { hub, runtime, dir: join(root, 'run') });
    expect(runtime.create).toHaveBeenCalled();
  });

  it('rejects as aborted when the abort lands in an upload even if Ollama now holds the part', async () => {
    const { hub, runtime } = fakes();
    const controller = new AbortController();
    const first = `sha256:${hex('1')}`;
    let held = false;
    runtime.hasBlob.mockImplementation(async (digest: string) => digest === first && held);
    runtime.uploadBlob.mockImplementation(async () => {
      held = true;
      controller.abort();
      throw new DOMException('aborted', 'AbortError');
    });
    const reported: number[] = [];
    await expect(
      runSplitImport(plan(), {
        hub,
        runtime,
        dir: join(root, 'run'),
        signal: controller.signal,
        onProgress: update => reported.push(update.completedBytes),
      })
    ).rejects.toThrow('aborted');
    expect(runtime.create).not.toHaveBeenCalled();
    expect(Math.max(...reported)).toBeLessThan(plan().parts[0].file.sizeBytes);
  });

  it('removes its own staged copy when Ollama holds the part by the time the download returns', async () => {
    const { hub, runtime } = fakes();
    const dir = join(root, 'run');
    const shared = `sha256:${hex('f')}`;
    let sharedDone = false;
    runtime.hasBlob.mockImplementation(async (digest: string) => digest === shared && sharedDone);
    const download = hub.download.getMockImplementation();
    hub.download.mockImplementation(async (file: HubGgufFile, destination: string, opts?: DownloadOptions) => {
      const result = await download!(file, destination, opts);
      if (file.sha256 === hex('f')) sharedDone = true;
      return result;
    });
    let stagedAtCreate: string[] = [];
    runtime.create.mockImplementationOnce(async () => {
      stagedAtCreate = await readdir(dir);
    });
    await runSplitImport(plan(), { hub, runtime, dir });
    expect(runtime.uploadBlob).not.toHaveBeenCalledWith(shared, expect.anything(), expect.anything());
    expect(stagedAtCreate).toEqual([]);
  });

  it('leaves a staged file it did not download when Ollama already holds the part', async () => {
    const { hub, runtime } = fakes({ present: [`sha256:${hex('f')}`] });
    const dir = join(root, 'run');
    let stagedAtCreate: string[] = [];
    runtime.create.mockImplementationOnce(async () => {
      stagedAtCreate = await readdir(dir);
    });
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${hex('f')}.gguf`), 'other run');
    await runSplitImport(plan(), { hub, runtime, dir });
    expect(stagedAtCreate).toEqual([`${hex('f')}.gguf`]);
  });

  it('stops waiting for a busy part when the run is aborted', async () => {
    const { hub, runtime } = fakes();
    const controller = new AbortController();
    hub.download.mockImplementation(async (_file: HubGgufFile, destination: string) => {
      setTimeout(() => controller.abort(), 20);
      throw new ModelFileBusyError('ollama', destination, null);
    });
    await expect(
      runSplitImport(plan(), { hub, runtime, dir: join(root, 'run'), signal: controller.signal })
    ).rejects.toBeDefined();
    expect(hub.download).toHaveBeenCalledTimes(1);
  });

  it('keeps the staged parts and creates nothing when a part fails', async () => {
    const { hub, runtime } = fakes({ failUpload: `sha256:${hex('2')}` });
    const dir = join(root, 'run');
    await expect(runSplitImport(plan(), { hub, runtime, dir })).rejects.toThrow('upload refused');
    expect(runtime.create).not.toHaveBeenCalled();
    expect(await readdir(dir)).toEqual([`${hex('2')}.gguf`]);
  });

  it('removes a staged part whose bytes do not match, so a retry downloads it again', async () => {
    const { hub, runtime } = fakes();
    const dir = join(root, 'run');
    const corrupt = join(dir, `${hex('1')}.gguf`);
    await mkdir(dir, { recursive: true });
    await writeFile(corrupt, 'bad bytes');
    hub.download.mockImplementationOnce(async (_file: HubGgufFile, destination: string) => {
      throw new ModelFileConflictError('ollama', basename(destination), 'sha256');
    });
    await expect(runSplitImport(plan(), { hub, runtime, dir })).rejects.toBeInstanceOf(ModelFileConflictError);
    await expect(stat(corrupt)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rejects when Ollama refuses the create', async () => {
    const { hub, runtime } = fakes({ failCreate: true });
    const dir = join(root, 'run');
    await expect(runSplitImport(plan(), { hub, runtime, dir })).rejects.toThrow('invalid split GGUF');
    expect(await readdir(dir)).toEqual([]);
  });

  it('stages each part under its digest, whatever its name or url', () => {
    const [first] = plan().parts;
    expect(splitPartPath(root, first)).toBe(join(root, `${hex('1')}.gguf`));
    const moved = { ...first, name: 'other-00001-of-00003.gguf', file: { ...first.file, url: 'https://hf.test/x' } };
    expect(splitPartPath(root, moved)).toBe(splitPartPath(root, first));
  });

  it('resumes a partial after a failed run even when the retry fetches a different revision', async () => {
    const { runtime } = fakes();
    const controller = new AbortController();
    const dir = join(root, 'run');
    const seen: string[] = [];
    const urls: string[] = [];
    const hub = {
      download: vi.fn(async (file: HubGgufFile, destination: string) => {
        seen.push(destination);
        urls.push(file.url);
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
    const moved = plan();
    for (const part of moved.parts) part.file = { ...part.file, url: part.file.url.replace('hf.test', 'hf.test/rev2') };
    await runSplitImport(moved, { hub, runtime, dir });
    expect(seen[1]).toBe(seen[0]);
    expect(urls[1]).toContain('/rev2/');
    expect(await readdir(dir)).toEqual([]);
  });

  it('counts staged bytes by digest, from a finished file or a partial', async () => {
    await writeFile(join(root, `${hex('1')}.gguf`), Buffer.alloc(120));
    await writeFile(join(root, `${hex('2')}.gguf.partial`), Buffer.alloc(40));
    await writeFile(join(root, `${hex('3')}.gguf`), Buffer.alloc(9999));
    const present = new Set([`sha256:${hex('3')}`]);
    expect(await stagedPartBytes(root, plan(), present)).toEqual(
      new Map([
        [`sha256:${hex('1')}`, 120],
        [`sha256:${hex('2')}`, 40],
      ])
    );
  });

  it('removes only this build staged files, partials and locks', async () => {
    const build = plan();
    const names = [
      `${hex('1')}.gguf`,
      `${hex('2')}.gguf.partial`,
      `${hex('2')}.gguf.partial.json`,
      `${hex('f')}.gguf.lock`,
    ];
    for (const name of [...names, `${hex('9')}.gguf`, `${hex('9')}.gguf.partial`])
      await writeFile(join(root, name), 'x');
    await removeSplitStaging(root, build);
    expect((await readdir(root)).sort()).toEqual([`${hex('9')}.gguf`, `${hex('9')}.gguf.partial`]);
  });

  it('leaves the staged files of digests in keep, partials and locks included', async () => {
    const build = plan();
    const kept = [
      `${hex('f')}.gguf`,
      `${hex('f')}.gguf.partial`,
      `${hex('f')}.gguf.partial.json`,
      `${hex('f')}.gguf.lock`,
    ];
    for (const name of [...kept, `${hex('1')}.gguf`, `${hex('1')}.gguf.lock`]) await writeFile(join(root, name), 'x');
    await removeSplitStaging(root, build, new Set([`sha256:${hex('f')}`]));
    expect((await readdir(root)).sort()).toEqual([...kept].sort());
  });

  it('refuses a bad name before downloading anything', async () => {
    const { hub, runtime } = fakes();
    const bad = plan();
    bad.parts[2] = { ...bad.parts[2], name: '..\\..\\x-00003-of-00003.gguf' };
    await expect(runSplitImport(bad, { hub, runtime, dir: join(root, 'run') })).rejects.toThrow(/cannot be imported/);
    expect(hub.download).not.toHaveBeenCalled();
  });

  it('refuses two parts with the same file name before downloading anything', async () => {
    const { hub, runtime } = fakes();
    const twin = plan();
    twin.parts[1] = { ...twin.parts[1], name: twin.parts[0].name };
    await expect(runSplitImport(twin, { hub, runtime, dir: join(root, 'run') })).rejects.toThrow(
      `two files are both named ${twin.parts[0].name}`
    );
    expect(hub.download).not.toHaveBeenCalled();
  });
});

describe('stagedPath', () => {
  const dir = join(tmpdir(), 'split-staged-path');

  it('accepts a name that merely starts with two dots', () => {
    expect(stagedPath(dir, '..foo-00001-of-00002.gguf')).toBe(join(dir, '..foo-00001-of-00002.gguf'));
  });

  it('refuses a name that leaves the folder or is not a plain file name', () => {
    for (const name of ['..', '.', '', '../x.gguf', '..\\x.gguf', 'a/../../x.gguf', '/etc/passwd', 'C:x.gguf'])
      expect(() => stagedPath(dir, name), name).toThrow(/cannot be staged/);
  });
});

describe('createFileNameProblem on Windows', () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;
  afterEach(() => Object.defineProperty(process, 'platform', platform));

  it.each(['a<b.gguf', 'a>b.gguf', 'a|b.gguf', 'a?b.gguf', 'a*b.gguf', 'a"b.gguf'])(
    'rejects %s only on win32',
    name => {
      Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
      expect(createFileNameProblem(name)).toBeNull();
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(createFileNameProblem(name)).toMatch(/Windows refuses/);
    }
  );

  it('refuses such a Hub file name before planning', () => {
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const build = splitBuild({ files: [shard(1, 300, { path: 'Q8_0/model-Q8_0-00001-of-00003?.gguf' })] });
    expect(splitImportBlock(hubDetail(), build)).toBe('unsupported-name');
  });
});

describe('sweepSplitImports', () => {
  it('removes staged part files untouched for the age limit and keeps recent ones', async () => {
    const root = await mkdtemp(join(tmpdir(), 'split-sweep-'));
    try {
      const week = 7 * 24 * 60 * 60 * 1000;
      const aged = new Date(Date.now() - 2 * week);
      for (const name of [`${hex('a')}.gguf.partial`, `${hex('a')}.gguf.partial.json`, `${hex('b')}.gguf.partial`])
        await writeFile(join(root, name), 'x');
      for (const name of [`${hex('a')}.gguf.partial`, `${hex('a')}.gguf.partial.json`])
        await utimes(join(root, name), aged, aged);
      await sweepSplitImports(root, week);
      expect(await readdir(root)).toEqual([`${hex('b')}.gguf.partial`]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('keeps a part whose record is old but whose partial was written recently', async () => {
    const root = await mkdtemp(join(tmpdir(), 'split-sweep-'));
    try {
      const week = 7 * 24 * 60 * 60 * 1000;
      const aged = new Date(Date.now() - 2 * week);
      const names = [`${hex('a')}.gguf.partial`, `${hex('a')}.gguf.partial.json`];
      for (const name of names) await writeFile(join(root, name), 'x');
      await utimes(join(root, names[1]), aged, aged);
      await sweepSplitImports(root, week);
      expect((await readdir(root)).sort()).toEqual(names);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('sweepSplitImports without a folder', () => {
  it('does nothing for a folder that does not exist yet', async () => {
    await expect(sweepSplitImports(join(tmpdir(), 'split-sweep-missing'))).resolves.toBeUndefined();
  });
});
