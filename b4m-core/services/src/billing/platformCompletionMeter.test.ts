import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModelBackend, type IPlatformAttempt, type IPlatformUsageEventInput, type ModelInfo } from '@bike4mind/common';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import { createPlatformAttribution, type PlatformAccounting } from './platformAccounting';
import {
  PlatformCompletionAccountingError,
  PlatformCompletionMeter,
  isPlatformCompletionAccountingError,
  type PlatformCompletionAccountingContext,
} from './platformCompletionMeter';
import { SreAccountingError, SreCompletionMeter, isSreAccountingError } from '../sreAgentService/accounting';

const model: ModelInfo = {
  id: 'test-model',
  name: 'Test model',
  type: 'text',
  backend: ModelBackend.Anthropic,
  contextWindow: 100000,
  pricing: { 100000: { input: 1e-6, output: 2e-6 } },
};
const messages = [{ role: 'user' as const, content: 'assess' }];
function harness(operation: 'secops_triage' | 'sre_diagnosis' = 'secops_triage') {
  const attempts = new Map<string, IPlatformAttempt>();
  const accounting = {
    diagnostics: vi.fn(async () => ({ attempts: [...attempts.values()], total: attempts.size, byState: {} })),
    register: vi.fn(async input => {
      const existing = attempts.get(input.providerCallId);
      if (existing) return existing;
      const attempt: IPlatformAttempt = { ...input, state: 'registered', createdAt: new Date(), updatedAt: new Date() };
      attempts.set(attempt.providerCallId, attempt);
      return attempt;
    }),
    claimDispatch: vi.fn(async (id: string, dispatchedAt: Date) => {
      const attempt = attempts.get(id);
      if (!attempt || attempt.state !== 'registered') return false;
      attempt.state = 'dispatched';
      attempt.dispatchedAt = dispatchedAt;
      return true;
    }),
    settle: vi.fn(async (id: string, _fact: IPlatformUsageEventInput) => {
      attempts.get(id)!.state = 'recorded';
    }),
    unresolved: vi.fn().mockResolvedValue(undefined),
  };
  const context: PlatformCompletionAccountingContext = {
    accounting: accounting as unknown as PlatformAccounting,
    attribution: createPlatformAttribution(
      { environment: 'test', operation },
      { logicalJobId: 'job', executionId: 'execution' }
    ),
    deadlineAt: Date.now() + 60_000,
  };
  const complete = vi.fn<ICompletionBackend['complete']>(async (_model, _messages, _options, callback) => {
    await callback(['result'], { inputTokens: 100, outputTokens: 20 });
  });
  const backend = { complete } as unknown as ICompletionBackend;
  const onText = vi.fn().mockResolvedValue(undefined);
  return { context, accounting, attempts, backend, complete, onText, meter: new PlatformCompletionMeter(context) };
}

afterEach(() => vi.useRealTimers());

describe('semantic platform completion metering', () => {
  it('keeps finding and health identities stable when unrelated work changes their order', async () => {
    const first = harness();
    await first.meter.complete(first.backend, model, messages, {}, first.onText, 'finding:abc');
    await first.meter.complete(first.backend, model, messages, {}, first.onText, 'health');
    const second = harness();
    await second.meter.complete(second.backend, model, messages, {}, second.onText, 'health');
    await second.meter.complete(second.backend, model, messages, {}, second.onText, 'finding:abc');
    const firstIds = first.accounting.register.mock.calls.map(([input]) => input.providerCallId);
    const secondIds = second.accounting.register.mock.calls.map(([input]) => input.providerCallId);
    expect(firstIds).toEqual([...secondIds].reverse());
    expect(new Set(firstIds).size).toBe(2);
    expect(firstIds[0]).toBe(createHash('sha256').update('execution:secops_triage:finding:abc').digest('hex'));
    expect(first.accounting.settle.mock.calls[0][1]).toMatchObject({
      attribution: expect.objectContaining({ operation: 'secops_triage' }),
      source: 'system',
      keySource: 'platform',
      providerInputTokens: 100,
      providerOutputTokens: 20,
      creditsCharged: 0,
    });
  });

  it('refuses replacement inference for the same paid semantic call after restart', async () => {
    const h = harness();
    await h.meter.complete(h.backend, model, messages, {}, h.onText, 'finding:abc');
    const restarted = new PlatformCompletionMeter(h.context);
    await expect(restarted.complete(h.backend, model, messages, {}, h.onText, 'finding:abc')).rejects.toMatchObject({
      reason: 'admission_refused',
    });
    expect(h.complete).toHaveBeenCalledOnce();
    await restarted.complete(h.backend, model, messages, {}, h.onText, 'health');
    expect(h.complete).toHaveBeenCalledTimes(2);
  });

  it.each(['diagnostics', 'register', 'claimDispatch'] as const)(
    'keeps %s datastore failures distinct from proven local refusal',
    async phase => {
      const h = harness();
      h.accounting[phase].mockRejectedValueOnce(new Error('database unavailable'));
      await expect(h.meter.complete(h.backend, model, messages, {}, h.onText, 'finding:abc')).rejects.toMatchObject({
        reason: 'admission_failed',
      });
      expect(h.complete).not.toHaveBeenCalled();
    }
  );

  it('identifies a rejected atomic dispatch claim as a refusal without a paid send', async () => {
    const h = harness();
    h.accounting.claimDispatch.mockResolvedValueOnce(false);
    await expect(h.meter.complete(h.backend, model, messages, {}, h.onText, 'finding:abc')).rejects.toMatchObject({
      reason: 'admission_refused',
    });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'x'.repeat(129)])('rejects invalid semantic identity before admission (%s)', async key => {
    const h = harness();
    await expect(h.meter.complete(h.backend, model, messages, {}, h.onText, key)).rejects.toMatchObject({
      reason: 'invalid_call_key',
    });
    expect(h.accounting.register).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('rejects unaudited provider routes before durable admission', async () => {
    const h = harness();
    await expect(
      h.meter.complete(h.backend, { ...model, backend: ModelBackend.Bedrock }, messages, {}, h.onText, 'health')
    ).rejects.toMatchObject({ reason: 'unsupported_provider' });
    expect(h.accounting.register).not.toHaveBeenCalled();
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('separates the same semantic key across explicit operations', async () => {
    const secops = harness();
    const sre = harness('sre_diagnosis');
    await secops.meter.complete(secops.backend, model, messages, {}, secops.onText, 'health');
    await sre.meter.complete(sre.backend, model, messages, {}, sre.onText, 'health');
    expect(secops.accounting.register.mock.calls[0][0].providerCallId).not.toBe(
      sre.accounting.register.mock.calls[0][0].providerCallId
    );
  });

  it('preserves the SRE provider identity and legacy accounting error guard', async () => {
    const h = harness('sre_diagnosis');
    await new SreCompletionMeter(h.context).complete(h.backend, model, messages, {}, h.onText);
    expect(h.accounting.register.mock.calls[0][0].providerCallId).toBe(
      createHash('sha256').update('execution:sre:1').digest('hex')
    );
    const error = await new SreCompletionMeter()
      .complete(h.backend, model, messages, {}, h.onText)
      .catch(value => value);
    expect(error).toBeInstanceOf(SreAccountingError);
    expect(isSreAccountingError(error)).toBe(true);
    expect(isPlatformCompletionAccountingError(error)).toBe(true);
    expect(error.message).toBe('SRE accounting requires durable recovery');
  });

  it('does not mislabel SecOps as SRE through the compatibility wrapper', async () => {
    const h = harness();
    await expect(
      new SreCompletionMeter(h.context).complete(h.backend, model, messages, {}, h.onText)
    ).rejects.toMatchObject({
      reason: 'invalid_attribution',
    });
    expect(h.complete).not.toHaveBeenCalled();
  });

  it('keeps measured SecOps usage frozen and awaited before returning', async () => {
    const h = harness();
    const frozenModel = structuredClone(model);
    const settled = Promise.withResolvers<void>();
    h.accounting.settle.mockReturnValue(settled.promise);
    h.complete.mockImplementation(async (_model, _messages, options, callback) => {
      expect(options).toMatchObject({ retryMode: 'single-attempt', stream: false, executeTools: false });
      frozenModel.pricing![100000].input = 0.5;
      await callback(['result'], { inputTokens: 100, outputTokens: 20 });
    });
    const done = vi.fn();
    const pending = h.meter.complete(h.backend, frozenModel, messages, {}, h.onText, 'health').then(done);
    await vi.waitFor(() => expect(h.accounting.settle).toHaveBeenCalledOnce());
    expect(h.accounting.settle.mock.calls[0][1].costUsd).toBeCloseTo(0.00014, 12);
    expect(done).not.toHaveBeenCalled();
    settled.resolve();
    await pending;
  });

  it('brands generic failures without treating arbitrary errors as accounting failures', () => {
    expect(isPlatformCompletionAccountingError(new PlatformCompletionAccountingError('settlement_failed'))).toBe(true);
    expect(isPlatformCompletionAccountingError(new Error('settlement_failed'))).toBe(false);
    expect(isPlatformCompletionAccountingError({ reason: 'settlement_failed' })).toBe(false);
  });
});
