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

  /**
   * Phase 3, regression case 1 (tool door): the session's pre-authorized lake ids ride the SAME
   * field this tool already reads from context, forwarded verbatim into the injection call.
   */
  it('forwards sessionPreauthorizedLakeIds into the injection call', async () => {
    getAccessibleDataLakePromptsMock.mockResolvedValueOnce([
      { id: 'managed', name: 'Managed Lake', systemPrompt: 'Sales playbook.' },
    ]);
    const context = makeContext({ sessionPreauthorizedLakeIds: ['managed'] });
    const result = await prependRetrievedLakePrompts(context, 'result text', ['datalake:managed'], new Set());

    expect(getAccessibleDataLakePromptsMock).toHaveBeenCalledWith(context, {
      restrictToDatalakeTags: ['datalake:managed'],
      preauthorizedLakeIds: ['managed'],
    });
    expect(result).toContain('Sales playbook.');
  });

  it('records preauthorizedLakeIdsUsed for an injected id drawn from the pre-authorized set', async () => {
    getAccessibleDataLakePromptsMock.mockResolvedValueOnce([
      { id: 'managed', name: 'Managed Lake', systemPrompt: 'Sales playbook.' },
      { id: 'ordinary', name: 'Ordinary Lake', systemPrompt: 'Ordinary.' },
    ]);
    const context = makeContext({ sessionPreauthorizedLakeIds: ['managed'] });
    await prependRetrievedLakePrompts(context, 'result text', ['datalake:managed', 'datalake:ordinary'], new Set());

    expect(context.statusUpdate).toHaveBeenCalledWith({
      promptMeta: {
        retrieval: {
          attempted: true,
          surfaces: [],
          dataLakeTags: [],
          injectedLakePromptIds: ['managed', 'ordinary'],
          preauthorizedLakeIdsUsed: ['managed'],
        },
      },
    });
  });

  it('omits preauthorizedLakeIdsUsed when no injected id came from the pre-authorized set', async () => {
    getAccessibleDataLakePromptsMock.mockResolvedValueOnce([
      { id: 'ordinary', name: 'Ordinary Lake', systemPrompt: 'Ordinary.' },
    ]);
    const context = makeContext();
    await prependRetrievedLakePrompts(context, 'result text', ['datalake:ordinary'], new Set());

    const call = (context.statusUpdate as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect('preauthorizedLakeIdsUsed' in call.promptMeta.retrieval).toBe(false);
  });
});
