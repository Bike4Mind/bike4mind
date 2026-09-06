import { describe, it, expect, vi, beforeEach } from 'vitest';

const getAccessibleDataLakePromptsMock = vi.fn();
vi.mock('../../../dataLakeService/getDataLakePrompts', () => ({
  getAccessibleDataLakePrompts: (...args: unknown[]) => getAccessibleDataLakePromptsMock(...args),
}));

import { prependRetrievedLakePrompts } from './retrievedLakePrompts';
import type { ToolContext } from './base/types';

const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } as never;

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    userId: 'u1',
    user: { id: 'u1' } as never,
    logger,
    statusUpdate: vi.fn().mockResolvedValue(undefined),
    db: {} as never,
    ...overrides,
  } as ToolContext;
}

describe('prependRetrievedLakePrompts', () => {
  beforeEach(() => {
    getAccessibleDataLakePromptsMock.mockReset();
  });

  it('records injectedLakePromptIds via statusUpdate when a prompt qualifies', async () => {
    getAccessibleDataLakePromptsMock.mockResolvedValueOnce([{ id: 'lake1', name: 'Lake One', systemPrompt: 'obey' }]);
    const context = makeContext();
    const result = await prependRetrievedLakePrompts(context, 'result text', ['datalake:lake1'], new Set());

    expect(result).toContain('result text');
    expect(context.statusUpdate).toHaveBeenCalledWith({
      promptMeta: {
        retrieval: {
          attempted: true,
          surfaces: [],
          dataLakeTags: [],
          injectedLakePromptIds: ['lake1'],
        },
      },
    });
  });

  it('records a present-and-empty array when the site ran but nothing qualified', async () => {
    getAccessibleDataLakePromptsMock.mockResolvedValueOnce([]);
    const context = makeContext();
    const result = await prependRetrievedLakePrompts(context, 'result text', ['datalake:lake1'], new Set());

    expect(result).toBe('result text');
    expect(context.statusUpdate).toHaveBeenCalledWith({
      promptMeta: {
        retrieval: {
          attempted: true,
          surfaces: [],
          dataLakeTags: [],
          injectedLakePromptIds: [],
        },
      },
    });
  });

  it('does not call statusUpdate when every tag was already injected this tool', async () => {
    const context = makeContext();
    const result = await prependRetrievedLakePrompts(
      context,
      'result text',
      ['datalake:lake1'],
      new Set(['datalake:lake1'])
    );

    expect(result).toBe('result text');
    expect(context.statusUpdate).not.toHaveBeenCalled();
    expect(getAccessibleDataLakePromptsMock).not.toHaveBeenCalled();
  });

  it('fails safe: a resolution error leaves the result text unchanged and skips the status write', async () => {
    getAccessibleDataLakePromptsMock.mockRejectedValueOnce(new Error('boom'));
    const context = makeContext();
    const result = await prependRetrievedLakePrompts(context, 'result text', ['datalake:lake1'], new Set());

    expect(result).toBe('result text');
  });
});
