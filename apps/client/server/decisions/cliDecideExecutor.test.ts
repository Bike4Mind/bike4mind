/**
 * The CLI `decide` executor's audit-log discipline: `executeToolWithLogging` persists whatever this
 * throws into `toolExecutionLog`, and a provider message can quote the caller's input, so only the
 * failure class may escape.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DecisionProviderError } from '@bike4mind/utils/decisionProviders';
import { DecisionRequestError } from './decisionErrors';
import { buildDecideExecutor } from './cliDecideExecutor';

const { findById, runDecision } = vi.hoisted(() => ({ findById: vi.fn(), runDecision: vi.fn() }));

vi.mock('@bike4mind/database', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/database')>()),
  userRepository: { findById: (...args: unknown[]) => findById(...args) },
}));
vi.mock('./runDecisionTool', () => ({
  runDecisionTool: (...args: unknown[]) => runDecision(...args),
}));

const executor = () => buildDecideExecutor({} as never);
const request = {
  toolName: 'decide' as const,
  userId: 'user-1',
  input: { input: 'Payouts are failing', questions: [{ type: 'predicate', name: 'urgent', instructions: 'Urgent?' }] },
};

beforeEach(() => {
  vi.clearAllMocks();
  findById.mockResolvedValue({ _id: 'user-1' });
});

describe('buildDecideExecutor', () => {
  it('returns the answers as JSON', async () => {
    runDecision.mockResolvedValue({
      id: 'dec_1',
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'urgent', probability: 0.9 }],
    });

    expect(JSON.parse(await executor()(request))).toEqual({
      id: 'dec_1',
      model: 'gpt-6-luna',
      answers: [{ type: 'predicate', name: 'urgent', probability: 0.9 }],
    });
    expect(findById).toHaveBeenCalledWith('user-1');
    expect(runDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'user-1',
        user: { _id: 'user-1' },
        authOrigin: 'session',
        source: 'cli',
        request: request.input,
      })
    );
  });

  it('rethrows a provider failure as its class, never the vendor message', async () => {
    runDecision.mockRejectedValue(
      new DecisionProviderError('invalid_request', 'choices[0] value "secret-plan" is not allowed')
    );

    const failure = await executor()(request).catch(error => error);
    expect(failure.message).toBe('provider_error: invalid_request');
    expect(failure.message).not.toContain('secret-plan');
  });

  it('rethrows a request-gate failure as its error code', async () => {
    runDecision.mockRejectedValue(new DecisionRequestError(422, 'invalid_request', 'questions', 'bad "x" value'));

    const failure = await executor()(request).catch(error => error);
    expect(failure.message).toBe('decision_request_error: invalid_request');
  });

  it('refuses image arrays before running the text-only CLI tool', async () => {
    await expect(
      executor()({ ...request, input: { ...request.input, input: [{ type: 'image', file_id: 'file-1' }] } })
    ).rejects.toThrow('ZodError');
    expect(runDecision).not.toHaveBeenCalled();
  });
});
