import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateToolList,
  validateMaxIterations,
  validateDefaultThoroughness,
  validateStringList,
  validateDefaultVariables,
  validateAgentUpdate,
  AgentValidationError,
} from './agentValidation';
import { ChatModels, IAgent, IUserDocument } from '@bike4mind/common';
import { ServiceUnavailableError } from '@bike4mind/common';

const { getCallerModelList } = vi.hoisted(() => ({ getCallerModelList: vi.fn() }));
vi.mock('@server/utils/callerModelList', () => ({ getCallerModelList }));

describe('validateToolList', () => {
  it('returns undefined for an undefined input (field is optional)', () => {
    expect(validateToolList(undefined, 'allowedTools')).toBeUndefined();
  });

  it('returns the array unchanged for a valid input', () => {
    expect(validateToolList(['web_search', 'shell'], 'allowedTools')).toEqual(['web_search', 'shell']);
  });

  it('rejects non-array values', () => {
    expect(() => validateToolList('web_search', 'allowedTools')).toThrow(/must be an array/);
    expect(() => validateToolList({ a: 1 }, 'allowedTools')).toThrow(/must be an array/);
  });

  it('rejects arrays over 100 entries (unbounded-blob guard)', () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `tool-${i}`);
    expect(() => validateToolList(tooMany, 'allowedTools')).toThrow(/at most 100/);
  });

  it('accepts arrays with exactly 100 entries (boundary)', () => {
    const justRight = Array.from({ length: 100 }, (_, i) => `tool-${i}`);
    expect(validateToolList(justRight, 'allowedTools')).toHaveLength(100);
  });

  it('rejects non-string entries', () => {
    expect(() => validateToolList(['ok', 123], 'allowedTools')).toThrow(/\[1\] must be a string/);
  });

  it('rejects entries longer than 256 characters (unbounded-blob guard)', () => {
    expect(() => validateToolList(['x'.repeat(257)], 'allowedTools')).toThrow(/256-character limit/);
  });

  it('accepts entries with exactly 256 characters (boundary)', () => {
    expect(validateToolList(['x'.repeat(256)], 'allowedTools')).toEqual(['x'.repeat(256)]);
  });
});

describe('validateMaxIterations', () => {
  it('returns undefined for an undefined input', () => {
    expect(validateMaxIterations(undefined)).toBeUndefined();
  });

  it('accepts a fully-populated valid object', () => {
    expect(validateMaxIterations({ quick: 3, medium: 5, very_thorough: 10 })).toEqual({
      quick: 3,
      medium: 5,
      very_thorough: 10,
    });
  });

  it('accepts partial objects (each level is independently optional)', () => {
    expect(validateMaxIterations({ quick: 3 })).toEqual({ quick: 3 });
  });

  it('rejects non-object inputs', () => {
    expect(() => validateMaxIterations(5)).toThrow(/must be an object/);
    expect(() => validateMaxIterations([1, 2, 3])).toThrow(/must be an object/);
    expect(() => validateMaxIterations(null)).toThrow(/must be an object/);
  });

  it('rejects non-integer values', () => {
    expect(() => validateMaxIterations({ quick: 3.5 })).toThrow(/must be an integer/);
    expect(() => validateMaxIterations({ medium: '5' })).toThrow(/must be an integer/);
  });

  it('rejects out-of-range values (matches Mongoose schema bound = 100)', () => {
    expect(() => validateMaxIterations({ quick: 0 })).toThrow(/between 1 and 100/);
    expect(() => validateMaxIterations({ medium: 101 })).toThrow(/between 1 and 100/);
    expect(() => validateMaxIterations({ very_thorough: -1 })).toThrow(/between 1 and 100/);
  });

  it('accepts boundary values 1 and 100', () => {
    expect(validateMaxIterations({ quick: 1, medium: 100 })).toEqual({ quick: 1, medium: 100 });
  });
});

describe('validateDefaultThoroughness', () => {
  it('returns undefined for unset values (undefined, null, empty string)', () => {
    // The form serializes "unconfigured" as `''` so we treat it like undefined -
    // otherwise editing an agent without thoroughness would 400 on every save.
    expect(validateDefaultThoroughness(undefined)).toBeUndefined();
    expect(validateDefaultThoroughness(null)).toBeUndefined();
    expect(validateDefaultThoroughness('')).toBeUndefined();
  });

  it('accepts each valid level', () => {
    expect(validateDefaultThoroughness('quick')).toBe('quick');
    expect(validateDefaultThoroughness('medium')).toBe('medium');
    expect(validateDefaultThoroughness('very_thorough')).toBe('very_thorough');
  });

  it('rejects unknown levels and non-string values', () => {
    expect(() => validateDefaultThoroughness('thorough')).toThrow(/quick, medium, very_thorough/);
    expect(() => validateDefaultThoroughness(123)).toThrow(/quick, medium, very_thorough/);
  });
});

describe('validateStringList', () => {
  it('returns undefined for undefined input', () => {
    expect(validateStringList(undefined, 'fallbackModels')).toBeUndefined();
  });

  it('accepts a valid array', () => {
    expect(validateStringList(['gpt-4', 'claude'], 'fallbackModels')).toEqual(['gpt-4', 'claude']);
  });

  it('mirrors validateToolList bounds (100 entries, 256 chars)', () => {
    expect(() => validateStringList(Array(101).fill('x'), 'f')).toThrow(/at most 100/);
    expect(() => validateStringList(['x'.repeat(257)], 'f')).toThrow(/256-character limit/);
  });

  it('rejects non-array and non-string entries', () => {
    expect(() => validateStringList('x', 'f')).toThrow(/must be an array/);
    expect(() => validateStringList([1], 'f')).toThrow(/\[0\] must be a string/);
  });
});

describe('validateDefaultVariables', () => {
  it('returns undefined for undefined and null', () => {
    expect(validateDefaultVariables(undefined)).toBeUndefined();
    expect(validateDefaultVariables(null)).toBeUndefined();
  });

  it('accepts an empty object (treats as "no variables")', () => {
    expect(validateDefaultVariables({})).toEqual({});
  });

  it('accepts a valid record', () => {
    expect(validateDefaultVariables({ tone: 'formal', mode: 'verbose' })).toEqual({
      tone: 'formal',
      mode: 'verbose',
    });
  });

  it('rejects non-object inputs', () => {
    expect(() => validateDefaultVariables('x')).toThrow(/flat object/);
    expect(() => validateDefaultVariables([])).toThrow(/flat object/);
  });

  it('rejects empty/whitespace keys (would survive Mongoose validator but break templating)', () => {
    expect(() => validateDefaultVariables({ '   ': 'value' })).toThrow(/keys must be non-empty/);
  });

  it('rejects non-string values', () => {
    expect(() => validateDefaultVariables({ k: 5 })).toThrow(/must be a string/);
  });

  it('caps entry count at 50', () => {
    const tooMany = Object.fromEntries(Array.from({ length: 51 }, (_, i) => [`k${i}`, 'v']));
    expect(() => validateDefaultVariables(tooMany)).toThrow(/at most 50/);
  });

  it('caps key length at 64 and value length at 1024', () => {
    expect(() => validateDefaultVariables({ ['k'.repeat(65)]: 'v' })).toThrow(/64-character/);
    expect(() => validateDefaultVariables({ k: 'v'.repeat(1025) })).toThrow(/1024-character/);
  });
});

describe('validateAgentUpdate', () => {
  const user = { id: 'user-1' } as IUserDocument;
  const tooMany = Array.from({ length: 101 }, (_, i) => `tool-${i}`);

  beforeEach(() => {
    getCallerModelList.mockReset();
    getCallerModelList.mockResolvedValue({
      models: [
        { id: 'gpt-6-astra', type: 'text' },
        { id: 'catalog-image-model', type: 'image' },
      ],
      supersededModels: [],
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ['preferredModel', { preferredModel: 'not-a-model' }],
    ['preferredImageModel', { preferredImageModel: 'not-a-model' }],
    ['temperature below 0', { temperature: -0.1 }],
    ['temperature above 2', { temperature: 2.1 }],
    ['maxTokens below 1', { maxTokens: 0 }],
    ['maxTokens above 128000', { maxTokens: 128001 }],
    ['triggerWords', { triggerWords: ['@-bad'] }],
    ['allowedTools', { allowedTools: tooMany }],
    ['deniedTools', { deniedTools: tooMany }],
    ['maxIterations', { maxIterations: { quick: 0 } }],
    ['defaultThoroughness', { defaultThoroughness: 'exhaustive' }],
    ['defaultVariables', { defaultVariables: { k: 5 } }],
    ['exclusiveMcpServers', { exclusiveMcpServers: 'not-an-array' }],
    ['fallbackModels', { fallbackModels: tooMany }],
  ])('rejects an invalid %s', async (_, body) => {
    await expect(validateAgentUpdate(body as Partial<IAgent>, user)).rejects.toThrow(AgentValidationError);
  });

  it('normalizes fields in place to the validators output', async () => {
    const body: Partial<IAgent> = { triggerWords: ['@Helper', '@helper'] };
    await validateAgentUpdate(body, user);
    expect(body).toStrictEqual({ triggerWords: ['@helper'] });
  });

  it('leaves absent fields absent', async () => {
    const body: Partial<IAgent> = {};
    await validateAgentUpdate(body, user);
    expect(Object.keys(body)).toEqual([]);
  });

  it('names a tool-list field by its label', async () => {
    const label = (field: string) => (field === 'allowedTools' ? 'allowed_tools' : field);
    await expect(validateAgentUpdate({ allowedTools: tooMany }, user, label)).rejects.toThrow(
      /^allowed_tools may contain/
    );
  });

  describe('model catalog', () => {
    it('accepts a catalog-only chat model the static enum lacks', async () => {
      await expect(
        validateAgentUpdate({ preferredModel: 'gpt-6-astra' } as Partial<IAgent>, user)
      ).resolves.toBeUndefined();
      expect(getCallerModelList).toHaveBeenCalledWith(user, expect.anything());
    });

    it('accepts a catalog-only image model the static enum lacks', async () => {
      await expect(
        validateAgentUpdate({ preferredImageModel: 'catalog-image-model' } as Partial<IAgent>, user)
      ).resolves.toBeUndefined();
    });

    it('rejects an id that is in neither the enum nor the catalog', async () => {
      await expect(validateAgentUpdate({ preferredModel: 'gpt-9-nope' } as Partial<IAgent>, user)).rejects.toThrow(
        /^Invalid model: gpt-9-nope$/
      );
      await expect(validateAgentUpdate({ preferredImageModel: 'img-nope' } as Partial<IAgent>, user)).rejects.toThrow(
        /^Invalid image model: img-nope$/
      );
    });

    it('rejects a catalog chat model used as an image model, and an image model used as a chat model', async () => {
      await expect(
        validateAgentUpdate({ preferredImageModel: 'gpt-6-astra' } as Partial<IAgent>, user)
      ).rejects.toThrow(/^Invalid image model: gpt-6-astra$/);
      await expect(
        validateAgentUpdate({ preferredModel: 'catalog-image-model' } as Partial<IAgent>, user)
      ).rejects.toThrow(/^Invalid model: catalog-image-model$/);
    });

    it('passes the request logger to the catalog lookup', async () => {
      const logger = { log: vi.fn() };
      await validateAgentUpdate({ preferredModel: 'gpt-6-astra' } as Partial<IAgent>, user, undefined, logger);
      expect(getCallerModelList).toHaveBeenCalledWith(user, logger);
    });

    it('skips the catalog lookup when the static enum already knows the model', async () => {
      await validateAgentUpdate({ preferredModel: ChatModels.CLAUDE_4_SONNET } as Partial<IAgent>, user);
      expect(getCallerModelList).not.toHaveBeenCalled();
    });

    it('rethrows a failure from the catalog lookup', async () => {
      getCallerModelList.mockRejectedValue(new Error('down'));
      await expect(validateAgentUpdate({ preferredModel: 'gpt-6-astra' } as Partial<IAgent>, user)).rejects.toThrow(
        'down'
      );
    });

    it('looks the catalog up once for an enum chat model plus a catalog-only image model', async () => {
      await validateAgentUpdate(
        { preferredModel: ChatModels.CLAUDE_4_SONNET, preferredImageModel: 'catalog-image-model' } as Partial<IAgent>,
        user
      );
      expect(getCallerModelList).toHaveBeenCalledTimes(1);
      await expect(
        validateAgentUpdate(
          { preferredModel: ChatModels.CLAUDE_4_SONNET, preferredImageModel: 'img-nope' } as Partial<IAgent>,
          user
        )
      ).rejects.toThrow(/^Invalid image model: img-nope$/);
    });

    it('rejects a field the cheap checks fail without a catalog lookup', async () => {
      await expect(
        validateAgentUpdate({ temperature: 5, preferredModel: 'gpt-6-astra' } as Partial<IAgent>, user)
      ).rejects.toThrow(/^Temperature must be between 0 and 2$/);
      expect(getCallerModelList).not.toHaveBeenCalled();
    });

    it('rejects a non-string model id as a bad request without a catalog lookup', async () => {
      await expect(validateAgentUpdate({ preferredModel: {} } as unknown as Partial<IAgent>, user)).rejects.toThrow(
        AgentValidationError
      );
      expect(getCallerModelList).not.toHaveBeenCalled();
    });

    it('reports an empty catalog as unavailable rather than blaming the model', async () => {
      getCallerModelList.mockResolvedValue({ models: [], supersededModels: [] });
      await expect(validateAgentUpdate({ preferredModel: 'gpt-6-astra' } as Partial<IAgent>, user)).rejects.toThrow(
        ServiceUnavailableError
      );
    });
  });
});
