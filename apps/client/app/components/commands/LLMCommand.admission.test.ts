import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';

const { post, toastError } = vi.hoisted(() => ({ post: vi.fn(), toastError: vi.fn() }));

vi.mock('@client/app/contexts/ApiContext', () => ({ api: { post } }));
vi.mock('sonner', () => ({ toast: { error: toastError, success: vi.fn() } }));
vi.mock('i18next', () => ({ default: { t: (key: string) => key } }));
vi.mock('@client/app/utils/llm', () => ({
  createOptimisticQuest: (_qc: unknown, _sid: unknown, _prompt: unknown, cb: () => unknown) => cb(),
  updateOptimisticQuest: (_qc: unknown, _q: unknown, _s: unknown, _d: unknown, cb: () => unknown) => cb(),
  createOptimisticSessionId: () => 'tmp-session-1',
}));

import { handleLLMCommand, isModelAccessRefusal } from './LLMCommand';
import { useQuestMasterUpgrade } from '../subscription/questMasterUpgrade';

type HandlerArgs = Parameters<typeof handleLLMCommand>[0];

const refusal = (status: number, error: string) => {
  const config = { headers: new AxiosHeaders() };
  return new AxiosError('Request failed', 'ERR_BAD_REQUEST', config, null, {
    status,
    statusText: '',
    headers: {},
    config,
    data: { error },
  });
};

const send = (invalidateQueries: ReturnType<typeof vi.fn>) =>
  handleLLMCommand({
    params: 'hello world',
    currentSession: { id: 'session-1' },
    model: 'model-turned-off',
    workBenchFiles: [],
    promptFileIds: [],
    queryClient: { invalidateQueries },
    tools: [],
    userId: 'user-1',
    modelConfigurations: [],
    sendJsonMessage: vi.fn(),
    skipRapidReply: true,
  } as unknown as HandlerArgs);

describe('handleLLMCommand - a model turned off after the picker loaded', () => {
  beforeEach(() => {
    post.mockReset();
    toastError.mockReset();
    useQuestMasterUpgrade.getState().close();
  });

  it('opens the Questmaster upgrade prompt for the typed second-quest refusal without a generic toast', async () => {
    const error = refusal(403, 'Free quest already started');
    error.response!.data = { errorCode: 'free_quest_limit_reached' };
    post.mockRejectedValue(error);

    await expect(send(vi.fn())).rejects.toBe(error);

    expect(useQuestMasterUpgrade.getState().isOpen).toBe(true);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('refetches model access on the admission refusal, so the picker drops the model', async () => {
    post.mockRejectedValue(refusal(403, 'Model "model-turned-off" is not accessible and no fallback available'));
    const invalidateQueries = vi.fn().mockResolvedValue(undefined);

    await expect(send(invalidateQueries)).rejects.toBeInstanceOf(AxiosError);

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ['llm-model-configurations'] });
    expect(toastError).toHaveBeenCalledWith('session.errors.modelUnavailable');
  });

  it('leaves access alone for any other 403', async () => {
    post.mockRejectedValue(refusal(403, 'Session belongs to another user'));
    const invalidateQueries = vi.fn();

    await expect(send(invalidateQueries)).rejects.toBeInstanceOf(AxiosError);

    expect(invalidateQueries).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('session.errors.noPermission');
    expect(useQuestMasterUpgrade.getState().isOpen).toBe(false);
  });
});

describe('isModelAccessRefusal', () => {
  it('recognizes only the admission refusal', () => {
    expect(isModelAccessRefusal({ error: 'Model "a/b:0" is not accessible and no fallback available' })).toBe(true);
    expect(isModelAccessRefusal({ error: 'Model "x" requires a paid plan.' })).toBe(false);
    expect(isModelAccessRefusal({ message: 'Model "x" is not accessible' })).toBe(false);
    expect(isModelAccessRefusal(undefined)).toBe(false);
  });
});
