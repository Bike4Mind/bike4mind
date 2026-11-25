import { describe, it, expect, vi } from 'vitest';
import {
  getImageModelCatalogEntry,
  ImageModels,
  validateImageRequest,
  type GenerateImageToolCall,
} from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import type { CreateImageJobsInput } from '../../../../imageJobs/types';
import {
  buildEditJobRequest,
  buildGenerateJobRequest,
  clampImageCount,
  resolveEditJobModel,
  type ImageToolConfig,
  type ImageToolJobsResult,
} from './imageJobTool';
import { imageGenerationTool } from './index';
import { imageEditTool } from '../imageEdit';

const FILE_ID = 'A'.repeat(24);
const MASK_ID = 'b'.repeat(24);

const selectionOf = (fields: Partial<GenerateImageToolCall>) => fields as GenerateImageToolCall;

const makeContext = () => {
  const statusUpdate = vi.fn().mockResolvedValue(undefined);
  const onStart = vi.fn();
  const onFinish = vi.fn();
  const context = {
    userId: 'u1',
    organizationId: 'org-1',
    questId: 'q1',
    user: { isAdmin: false },
    logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() },
    statusUpdate,
    onStart,
    onFinish,
  } as unknown as ToolContext;
  return { context, statusUpdate, onStart, onFinish };
};

const started = (ids: string[], overrides: Partial<{ created: boolean; state: string }> = {}): ImageToolJobsResult =>
  ({
    ok: true,
    created: overrides.created ?? true,
    groupId: 'g1',
    jobs: ids.map(id => ({ id, state: overrides.state ?? 'pending' })),
  }) as unknown as ImageToolJobsResult;

const jobConfig = (selection: Partial<GenerateImageToolCall> | undefined, result: ImageToolJobsResult) => {
  const createJobs = vi.fn(async (_input: CreateImageJobsInput) => result);
  const config: ImageToolConfig = { selection: selection && selectionOf(selection), createJobs };
  return { config, createJobs };
};

type ToolFn = (args: unknown) => Promise<string>;
const generate = (context: ToolContext, config: unknown) =>
  imageGenerationTool.implementation(context, config).toolFn as ToolFn;
const edit = (context: ToolContext, config: unknown) => imageEditTool.implementation(context, config).toolFn as ToolFn;

describe('buildGenerateJobRequest', () => {
  it('lets the tool call win over the selection and maps a legacy quality alias to its billed tier', () => {
    const request = buildGenerateJobRequest(
      selectionOf({ model: ImageModels.GPT_IMAGE_1_5, size: '1024x1024', quality: 'low' }),
      'a kite',
      { size: '1536x1024', quality: 'hd' }
    );
    expect(request).toMatchObject({
      model: ImageModels.GPT_IMAGE_1_5,
      mode: 'generate',
      prompt: 'a kite',
      size: '1536x1024',
      quality: 'high',
    });
  });

  it('keeps the selected model and carries a transparent request through for the engine to refuse', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.GPT_IMAGE_2 }), 'a logo', {
      background: 'transparent',
    });
    expect(request.model).toBe(ImageModels.GPT_IMAGE_2);
    expect(request.transparentBackground).toBe(true);
    expect(
      validateImageRequest({ ...request, count: 1 }, getImageModelCatalogEntry(ImageModels.GPT_IMAGE_2))
    ).toMatchObject({
      ok: false,
      failures: [expect.objectContaining({ code: 'unsupported_transparent_background' })],
    });
  });

  it('keeps a transparent request on a capable model', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.GPT_IMAGE_1_5 }), 'a logo', {
      background: 'transparent',
    });
    expect(request.model).toBe(ImageModels.GPT_IMAGE_1_5);
    expect(request.transparentBackground).toBe(true);
  });

  it('sets no transparency when none is requested', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.GPT_IMAGE_2 }), 'a logo', {});
    expect(request.model).toBe(ImageModels.GPT_IMAGE_2);
    expect(request.transparentBackground).toBeUndefined();
  });

  it('drops a saved selection value the model cannot take, but keeps a tool value for the engine to refuse', () => {
    const fromSelection = buildGenerateJobRequest(
      selectionOf({ model: ImageModels.FLUX_PRO_ULTRA, output_format: 'webp' }),
      'p',
      {}
    );
    expect(fromSelection.outputFormat).toBeUndefined();

    const fromTool = buildGenerateJobRequest(selectionOf({ model: ImageModels.FLUX_PRO_ULTRA }), 'p', {
      outputFormat: 'webp',
    });
    expect(fromTool.outputFormat).toBe('webp');
  });

  it('sends a tool size as its aspect ratio to a model sized by aspect ratio, behind the saved ratio', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.FLUX_PRO_ULTRA }), 'p', {
      size: '1536x1024',
    });
    expect(request.size).toBeUndefined();
    expect(request.aspectRatio).toBe('3:2');

    const saved = buildGenerateJobRequest(
      selectionOf({ model: ImageModels.FLUX_PRO_ULTRA, aspect_ratio: '16:9' }),
      'p',
      { size: '1024x1024' }
    );
    expect(saved.size).toBeUndefined();
    expect(saved.aspectRatio).toBe('16:9');
  });

  it.each([
    [ImageModels.GEMINI_3_PRO_IMAGE, '1024x1024'],
    [ImageModels.GROK_IMAGINE_IMAGE_QUALITY, '1536x1024'],
    [ImageModels.FLUX_PRO_1_1, '1536x1024'],
  ])('drops a tool size %s cannot produce instead of refusing it', (model, size) => {
    const request = buildGenerateJobRequest(selectionOf({ model }), 'p', { size });
    expect(request.size).toBeUndefined();
  });

  it('keeps a tool size a dimension-sized model can produce', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.FLUX_PRO_1_1 }), 'p', {
      size: '1024x1024',
    });
    expect(request.size).toBe('1024x1024');
  });

  it('drops a tool quality a non-GPT model cannot take instead of refusing it', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.FLUX_PRO_ULTRA }), 'p', {
      quality: 'high',
    });
    expect(request.quality).toBeUndefined();
  });

  it('keeps the saved aspect ratio and drops a saved size on a model sized by aspect ratio', () => {
    const request = buildGenerateJobRequest(
      selectionOf({ model: ImageModels.FLUX_PRO_ULTRA, size: '1024x1536', aspect_ratio: '16:9' }),
      'p',
      {}
    );
    expect(request.size).toBeUndefined();
    expect(request.aspectRatio).toBe('16:9');
  });

  it('keeps a tool size as a size on a model sized by pixels', () => {
    const request = buildGenerateJobRequest(selectionOf({ model: ImageModels.GPT_IMAGE_1_5 }), 'p', {
      size: '1536x1024',
    });
    expect(request.size).toBe('1536x1024');
    expect(request.aspectRatio).toBeUndefined();
  });

  it("sends a BFL selection's width/height as the size, and drops a pair the model cannot take", () => {
    const fitted = buildGenerateJobRequest(
      selectionOf({ model: ImageModels.FLUX_PRO, size: '1024x768', width: 1024, height: 576 }),
      'p',
      {}
    );
    expect(fitted.size).toBe('1024x576');

    const outOfBounds = buildGenerateJobRequest(
      selectionOf({ model: ImageModels.FLUX_PRO, width: 4096, height: 4096 }),
      'p',
      {}
    );
    expect(outOfBounds.size).toBeUndefined();
  });
});

describe('buildEditJobRequest', () => {
  it('sends the source and mask as lowercased file inputs', () => {
    const request = buildEditJobRequest(
      selectionOf({ model: ImageModels.GPT_IMAGE_1_5 }),
      'make it blue',
      {
        image: FILE_ID,
        mask: MASK_ID,
      },
      {}
    );
    expect(request).toMatchObject({ mode: 'edit', model: ImageModels.GPT_IMAGE_1_5 });
    expect(request.inputs).toEqual([
      { role: 'edit_source', fileId: FILE_ID.toLowerCase() },
      { role: 'mask', fileId: MASK_ID },
    ]);
  });

  it('swaps a mask-only inpainting model for FLUX Kontext when no mask is given', () => {
    const selection = selectionOf({ model: ImageModels.FLUX_PRO_ULTRA });
    expect(resolveEditJobModel(selection, true)).toBe(ImageModels.FLUX_PRO_FILL);
    expect(resolveEditJobModel(selection, false)).toBe(ImageModels.FLUX_KONTEXT_PRO);
  });

  it('drops a tool size on an edit model that takes its source image size', () => {
    const request = buildEditJobRequest(
      selectionOf({ model: ImageModels.FLUX_PRO_ULTRA }),
      'p',
      { image: FILE_ID },
      { size: '1536x1024' }
    );
    expect(request.model).toBe(ImageModels.FLUX_KONTEXT_PRO);
    expect(request.size).toBeUndefined();
    expect(request.aspectRatio).toBeUndefined();
  });

  it('prefers the selection edit model', () => {
    expect(
      resolveEditJobModel(selectionOf({ model: ImageModels.GPT_IMAGE_2, editModel: ImageModels.GPT_IMAGE_2 }), true)
    ).toBe(ImageModels.GPT_IMAGE_2);
  });
});

describe('clampImageCount', () => {
  it('holds a batch to 1..4 and says so when it clamped', () => {
    expect(clampImageCount(undefined)).toEqual({ count: 1 });
    expect(clampImageCount(3)).toEqual({ count: 3 });
    expect(clampImageCount(9)).toMatchObject({ count: 4, note: expect.stringContaining('not 9') });
    expect(clampImageCount(0)).toMatchObject({ count: 1 });
  });
});

describe('image_generation on the job engine', () => {
  it('starts the batch, announces one card per job and never bills through onStart/onFinish', async () => {
    const { context, statusUpdate, onStart, onFinish } = makeContext();
    const { config, createJobs } = jobConfig({ model: ImageModels.GPT_IMAGE_2 }, started(['j1', 'j2']));

    const result = JSON.parse(await generate(context, config)({ prompt: 'a red bicycle', n: 2 }));

    expect(result).toEqual({ jobIds: ['j1', 'j2'], groupId: 'g1' });
    expect(createJobs).toHaveBeenCalledWith(
      expect.objectContaining({
        user: { id: 'u1', organizationId: 'org-1', adminRoleWithheld: true },
        count: 2,
        source: 'agent',
        questId: 'q1',
        idempotencyKey: expect.any(String),
        request: expect.objectContaining({ model: ImageModels.GPT_IMAGE_2, mode: 'generate', prompt: 'a red bicycle' }),
      })
    );
    expect(statusUpdate).toHaveBeenCalledWith({
      generationJobs: [
        { id: 'j1', kind: 'image' },
        { id: 'j2', kind: 'image' },
      ],
    });
    expect(onStart).not.toHaveBeenCalled();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('tells the model when it clamped the batch, along with a delivery note', async () => {
    const { context } = makeContext();
    const { config, createJobs } = jobConfig({ model: ImageModels.GPT_IMAGE_2 }, started(['j1']));
    config.deliveryNote = 'Images arrive in the thread.';

    const result = JSON.parse(await generate(context, config)({ prompt: 'p', n: 10 }));

    expect(createJobs.mock.calls[0][0].count).toBe(4);
    expect(result.note).toContain('not 10');
    expect(result.note).toContain('Images arrive in the thread.');
  });

  it('reports each unsupported field reason on a refusal', async () => {
    const { context, statusUpdate } = makeContext();
    const refusal = {
      ok: false,
      status: 422,
      code: 'unsupported_by_model',
      message: 'unsupported',
      failures: [{ field: 'size', reason: 'This model takes no size.' }],
    } as unknown as ImageToolJobsResult;
    const { config } = jobConfig({ model: ImageModels.GPT_IMAGE_2 }, refusal);

    const result = await generate(context, config)({ prompt: 'p' });

    expect(result).toBe('Image generation failed (unsupported_by_model): This model takes no size.');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('reports a replay of a job that already failed instead of a fresh card', async () => {
    const { context, statusUpdate } = makeContext();
    const { config } = jobConfig(
      { model: ImageModels.GPT_IMAGE_2 },
      started(['j1'], { created: false, state: 'failed' })
    );

    const result = await generate(context, config)({ prompt: 'p' });

    expect(result).toContain('Image generation failed');
    expect(statusUpdate).not.toHaveBeenCalled();
  });

  it('still offers the model picker when the user has chosen no model', async () => {
    const { context, statusUpdate } = makeContext();
    const { config, createJobs } = jobConfig(undefined, started(['j1']));

    const result = await generate(context, config)({ prompt: 'p' });

    expect(result).toContain('model picker');
    expect(statusUpdate.mock.calls[0][0]).toHaveProperty('pendingAction');
    expect(createJobs).not.toHaveBeenCalled();
  });
});

describe('edit_image on the job engine', () => {
  it('starts one edit job for an own file id', async () => {
    const { context, statusUpdate, onStart } = makeContext();
    const { config, createJobs } = jobConfig({ model: ImageModels.GPT_IMAGE_1_5 }, started(['e1']));

    const result = JSON.parse(await edit(context, config)({ image: FILE_ID, prompt: 'make it blue' }));

    expect(result.jobIds).toEqual(['e1']);
    expect(createJobs.mock.calls[0][0]).toMatchObject({
      count: 1,
      request: { mode: 'edit', inputs: [{ role: 'edit_source', fileId: FILE_ID.toLowerCase() }] },
    });
    expect(statusUpdate).toHaveBeenCalledWith({ generationJobs: [{ id: 'e1', kind: 'image' }] });
    expect(onStart).not.toHaveBeenCalled();
  });

  it.each([
    ['a URL', 'https://example.com/cat.png'],
    ['a generated image key', '86cdc650-43d2-416e-aca6-23ff4fe23081.png'],
  ])('keeps %s on the in-process edit', async (_label, image) => {
    const { context } = makeContext();
    const { config, createJobs } = jobConfig({ model: ImageModels.GPT_IMAGE_1_5 }, started(['e1']));

    await edit(context, config)({ image, prompt: 'make it blue' }).catch(() => undefined);

    expect(createJobs).not.toHaveBeenCalled();
  });

  it.each(['input_image_not_found', 'unsupported_input_image'])(
    'falls back to the in-process edit on %s',
    async code => {
      const { context, statusUpdate } = makeContext();
      const notOwned = { ok: false, status: 422, code, message: 'refused' } as unknown as ImageToolJobsResult;
      const { config, createJobs } = jobConfig({ model: ImageModels.GPT_IMAGE_1_5 }, notOwned);

      // The in-process path then runs against this bare context and fails on its own; only the hand-off matters here.
      await edit(context, config)({ image: FILE_ID, prompt: 'make it blue' }).catch(() => undefined);

      expect(createJobs).toHaveBeenCalledTimes(1);
      expect(statusUpdate).not.toHaveBeenCalledWith(expect.objectContaining({ generationJobs: expect.anything() }));
    }
  );
});
