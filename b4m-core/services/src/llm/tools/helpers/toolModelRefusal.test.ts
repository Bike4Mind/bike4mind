import { describe, expect, it, vi } from 'vitest';
import { MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE } from '@bike4mind/common';
import { BadRequestError, ForbiddenError } from '@bike4mind/utils';
import type { ToolContext } from '../base/types';
import { toolModelRefusal } from './toolModelRefusal';

const createContext = () => ({
  logger: { warn: vi.fn(), error: vi.fn() } as unknown as ToolContext['logger'],
});

const refusingWith = (error: Error) => ({
  assert: vi.fn(async (_modelId: string) => {
    throw error;
  }),
});

describe('toolModelRefusal', () => {
  it('returns null when the model is admitted', async () => {
    const context = createContext();
    const admission = { assert: vi.fn(async (_modelId: string) => {}) };

    await expect(toolModelRefusal(context, admission, 'gpt-image-2', 'image_generation')).resolves.toBeNull();
    expect(admission.assert).toHaveBeenCalledWith('gpt-image-2');
    expect(context.logger.warn).not.toHaveBeenCalled();
  });

  it('returns a free-tier refusal as the tool result, logged at warn', async () => {
    const context = createContext();
    const refusal = new ForbiddenError('Model "flux-pro-1.1-ultra" requires a paid plan.', {
      errorCode: MODEL_REQUIRES_SUBSCRIPTION_ERROR_CODE,
    });

    await expect(
      toolModelRefusal(context, refusingWith(refusal), 'flux-pro-1.1-ultra', 'image_generation')
    ).resolves.toBe('Error: Model "flux-pro-1.1-ultra" requires a paid plan.');
    expect(context.logger.warn).toHaveBeenCalledWith(expect.stringContaining('[image_generation]'), {
      modelId: 'flux-pro-1.1-ultra',
    });
    expect(context.logger.error).not.toHaveBeenCalled();
  });

  it.each([
    ['a ForbiddenError without the subscription code', new ForbiddenError('Model "x" is not accessible')],
    ['a disabled model', new BadRequestError('Model "x" is currently unavailable')],
    ['an unexpected failure', new Error('database unavailable')],
  ])('rethrows %s', async (_label, error) => {
    const context = createContext();

    await expect(toolModelRefusal(context, refusingWith(error), 'x', 'image_generation')).rejects.toBe(error);
    expect(context.logger.warn).not.toHaveBeenCalled();
  });
});
