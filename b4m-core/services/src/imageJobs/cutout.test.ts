import sharp from 'sharp';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_IMAGE_MODELS,
  CreditHolderType,
  IMAGE_MODEL_CATALOG,
  type ImageModels as ImageModelId,
} from '@bike4mind/common';
import {
  createImageProviderRegistry,
  type ImageProvider,
  type ProviderTerminalResult,
} from '@bike4mind/utils/imageProviders';
import { Logger } from '@bike4mind/observability';
import { createInMemoryGenerationJobRepository } from '../generationJobs/__test__/inMemoryGenerationJobRepository';
import { GenerationJobEngine } from '../generationJobs/engine';
import type { CreditHoldAdapters } from '../creditService/creditHold';
import { CUTOUT_MODEL, CUTOUT_PROMPT, createCutoutJob } from './cutout';
import { createImageJobHandler } from './imageJobHandler';
import type { CreateImageJobsDeps, CreateImageJobsResult, ImageJob } from './types';

vi.mock('../creditService/creditHold', () => ({
  holdCredits: vi.fn(),
  releaseCreditHold: vi.fn(async () => undefined),
  settleCreditHold: vi.fn(async (_hold: unknown, charged: number) => charged),
}));
import { holdCredits, releaseCreditHold, settleCreditHold } from '../creditService/creditHold';

const OPENAI_IMAGE_MODEL_IDS = ALL_IMAGE_MODELS.filter(id => IMAGE_MODEL_CATALOG[id].provider === 'openai');
const SOURCE_FILE_ID = 'a'.repeat(24);
const SOURCE_WIDTH = 120;
const SOURCE_HEIGHT = 80;

type Generate = Extract<ImageProvider, { mode: 'sync' }>['generate'];

const rgba = (width: number, height: number, pixel: (x: number, y: number) => [number, number, number, number]) => {
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data.set(pixel(x, y), (y * width + x) * 4);
  }
  return sharp(data, { raw: { width, height, channels: 4 } })
    .png()
    .toBuffer();
};

// A "product shot": every pixel distinct, so a re-rendered pixel cannot pass as the original.
const makeSource = () => rgba(SOURCE_WIDTH, SOURCE_HEIGHT, (x, y) => [x * 2, y * 3, (x + y) % 256, 255]);
// The matte model's answer: its own (wrong-coloured) product on the left half, transparent on the right.
const makeMatte = (width: number, height: number) => rgba(width, height, x => [9, 9, 9, x < width / 2 ? 255 : 0]);

// Just the PNG signature and IHDR chunk: enough for a header read, so a huge image costs nothing to "load".
const pngHeader = (width: number, height: number) => {
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.set([8, 6, 0, 0, 0], 16);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), ihdr]);
};

const decode = async (bytes: Buffer) => sharp(bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });

const inline = (bytes: Buffer): ProviderTerminalResult => ({
  status: 'succeeded',
  output: { kind: 'inline', base64: bytes.toString('base64'), contentType: 'image/png' },
});

const setup = async (generate: Generate, mimeType = 'image/jpeg', sourceBytes?: Buffer) => {
  let clock = new Date('2026-11-12T00:00:00Z');
  const repository = createInMemoryGenerationJobRepository({ now: () => clock });
  const queue: string[] = [];
  const source = sourceBytes ?? (await makeSource());
  const provider: ImageProvider = {
    mode: 'sync',
    id: 'openai',
    models: OPENAI_IMAGE_MODEL_IDS as ImageModelId[],
    generate,
    fetchOutput: async output => Buffer.from(output.kind === 'inline' ? output.base64 : '', 'base64'),
  };
  const deps: CreateImageJobsDeps = {
    assertModelAdmission: vi.fn(async () => {}),
    repository,
    providers: createImageProviderRegistry([provider]),
    getSettings: async () => ({ enforceCredits: true }),
    resolveApiKey: vi.fn(async () => 'key'),
    loadInputFile: vi.fn(async () => ({ bytes: source, mimeType })),
    moderate: vi.fn(async () => ({ blocked: false as const })),
    checkStorageFor: async () => undefined,
    saveToFiles: vi.fn(async ({ generation: { jobId } }: { generation: { jobId: string } }) => ({
      saved: true as const,
      fileId: `file-${jobId}`,
      s3Key: `files/${jobId}.png`,
      fileName: 'cutout.png',
    })),
    saveToGeneratedBucket: vi.fn(async ({ key }: { key: string }) => ({ s3Key: key })),
    // creditHold is module-mocked, so the adapters are never touched.
    credits: {} as CreditHoldAdapters,
    enqueue: vi.fn(async (jobId: string) => {
      queue.push(jobId);
    }),
    recordUsage: vi.fn(async () => undefined),
    now: () => clock,
    logger: new Logger({ metadata: { test: 'imageCutout' } }),
    engine: { failBeforeStart: (jobId, error) => engine.failBeforeStart(jobId, error) },
  };
  const engine = new GenerationJobEngine({
    repository,
    handlers: [createImageJobHandler(deps)],
    enqueue: deps.enqueue,
    notify: async () => undefined,
    now: () => clock,
    logger: deps.logger,
    leaseMs: 330_000,
  });
  const runToCompletion = async () => {
    for (let i = 0; i < 20 && queue.length; i++) {
      const jobId = queue.shift();
      if (!jobId) break;
      clock = new Date(clock.getTime() + 60_000);
      await engine.step(jobId);
    }
  };
  const jobOf = (created: CreateImageJobsResult): ImageJob => {
    if (!created.ok) throw new Error(`refused: ${created.code}`);
    const job = repository.jobs.get(created.jobs[0].id);
    if (!job || job.kind !== 'image') throw new Error('image job vanished');
    return job;
  };
  const create = () =>
    createCutoutJob({ user: { id: 'u1', organizationId: null }, fileId: SOURCE_FILE_ID, source: 'studio' }, deps);
  return { deps, source, create, runToCompletion, jobOf };
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(holdCredits).mockImplementation(async params => ({
    ownerId: params.userId,
    ownerType: CreditHolderType.User,
    userId: params.userId,
    organizationId: null,
    reservedCredits: params.requiredCredits,
    balanceAfterHold: 1000,
  }));
});

describe('createCutoutJob', () => {
  it('holds credits for one cutout job on the canvas closest to the source aspect', async () => {
    const t = await setup(vi.fn<Generate>());
    const job = t.jobOf(await t.create());

    expect(job.payload.purpose).toBe('cutout');
    expect(job.payload.request).toMatchObject({
      model: CUTOUT_MODEL,
      mode: 'edit',
      prompt: CUTOUT_PROMPT,
      inputs: [{ role: 'edit_source', fileId: SOURCE_FILE_ID }],
      size: '1536x1024',
      outputFormat: 'png',
      transparentBackground: true,
    });
    expect(holdCredits).toHaveBeenCalledTimes(1);
    expect(vi.mocked(holdCredits).mock.calls[0][0].requiredCredits).toBeGreaterThan(0);
  });

  it('refuses a format the compositor cannot decode before any hold', async () => {
    const t = await setup(vi.fn<Generate>(), 'image/webp');
    const result = await t.create();

    expect(result).toMatchObject({ ok: false, status: 422, code: 'unsupported_input_image' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses a source whose padded canvas is over the decode budget before any hold', async () => {
    // 60MP of source, but padded to a 3:2 canvas it is 30000x20000.
    const t = await setup(vi.fn<Generate>(), 'image/png', pngHeader(30_000, 2_000));

    expect(await t.create()).toMatchObject({ ok: false, status: 422, code: 'unsupported_input_image' });
    expect(holdCredits).not.toHaveBeenCalled();
  });

  it('refuses a file the caller does not have', async () => {
    const t = await setup(vi.fn<Generate>());
    vi.mocked(t.deps.loadInputFile).mockResolvedValueOnce(null);

    expect(await t.create()).toMatchObject({ ok: false, status: 422, code: 'input_image_not_found' });
    expect(holdCredits).not.toHaveBeenCalled();
  });
});

describe('cutout job through the real engine', () => {
  it('sends the padded source, keeps the original pixels under the matte alpha, records lineage and settles', async () => {
    const generate = vi.fn<Generate>(async () => inline(await makeMatte(1536, 1024)));
    const t = await setup(generate);
    const created = await t.create();
    const job = t.jobOf(created);
    await t.runToCompletion();

    expect(t.jobOf(created).state).toBe('succeeded');
    const sent = generate.mock.calls[0][1].images;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ role: 'edit_source', mimeType: 'image/png' });
    expect(await sharp(sent[0].bytes).metadata()).toMatchObject({ width: 1536, height: 1024 });

    const saved = vi.mocked(t.deps.saveToFiles).mock.calls[0][0];
    expect(saved.contentType).toBe('image/png');
    expect(saved.derivedFrom).toEqual([{ fileId: SOURCE_FILE_ID, role: 'edit_source', jobId: job.id }]);
    expect(t.deps.moderate).toHaveBeenCalledWith(expect.objectContaining({ bytes: saved.bytes }));

    const original = await decode(t.source);
    const cutout = await decode(saved.bytes);
    expect(cutout.info).toMatchObject({ width: SOURCE_WIDTH, height: SOURCE_HEIGHT });
    for (let index = 0; index < original.data.length; index += 4) {
      expect(cutout.data.subarray(index, index + 3)).toEqual(original.data.subarray(index, index + 3));
    }
    const alphaAt = (x: number, y: number) => cutout.data[(y * SOURCE_WIDTH + x) * 4 + 3];
    expect(alphaAt(5, 40)).toBe(255);
    expect(alphaAt(115, 40)).toBe(0);

    expect(settleCreditHold).toHaveBeenCalledTimes(1);
    expect(vi.mocked(settleCreditHold).mock.calls[0][2]).toMatchObject({
      type: 'image_edit_usage',
      model: CUTOUT_MODEL,
    });
    expect(releaseCreditHold).not.toHaveBeenCalled();
  });

  it('fails a matte that does not line up and refunds the hold without saving', async () => {
    const t = await setup(vi.fn<Generate>(async () => inline(await makeMatte(1024, 1024))));
    const created = await t.create();
    await t.runToCompletion();

    expect(t.jobOf(created)).toMatchObject({ state: 'failed', error: { code: 'provider_error' } });
    expect(t.deps.saveToFiles).not.toHaveBeenCalled();
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });

  it('refunds the hold when the provider fails', async () => {
    const t = await setup(
      vi.fn<Generate>(async () => ({ status: 'failed', retryable: false, message: 'boom', raw: {} }))
    );
    const created = await t.create();
    await t.runToCompletion();

    expect(t.jobOf(created).state).toBe('failed');
    expect(releaseCreditHold).toHaveBeenCalledTimes(1);
    expect(settleCreditHold).not.toHaveBeenCalled();
  });
});
