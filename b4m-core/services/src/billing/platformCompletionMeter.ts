import { createHash } from 'node:crypto';
import { ModelBackend, PlatformAttribution, type IPlatformAttribution, type ModelInfo } from '@bike4mind/common';
import type { CompletionInfo, ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';
import { PlatformAccounting, pricePlatformUsage } from './platformAccounting';

export interface PlatformCompletionAccountingContext {
  accounting: PlatformAccounting;
  attribution: IPlatformAttribution;
  deadlineAt: number;
  persistenceReserveMs?: number;
}

const accountingFailure = Symbol.for('bike4mind.platform.accounting.failure');

export class PlatformCompletionAccountingError extends Error {
  readonly [accountingFailure] = true;
  constructor(
    readonly reason: string,
    readonly providerCallId?: string,
    options?: ErrorOptions
  ) {
    super('Platform completion accounting requires durable recovery', options);
    this.name = 'PlatformCompletionAccountingError';
  }
}

export function isPlatformCompletionAccountingError(error: unknown): error is PlatformCompletionAccountingError {
  return error instanceof Error && accountingFailure in error && error[accountingFailure] === true;
}

export class PlatformCompletionMeter {
  constructor(private readonly context?: PlatformCompletionAccountingContext) {}

  protected createError(
    reason: string,
    providerCallId?: string,
    options?: ErrorOptions
  ): PlatformCompletionAccountingError {
    return new PlatformCompletionAccountingError(reason, providerCallId, options);
  }

  protected createProviderCallId(attribution: IPlatformAttribution, callKey?: string): string {
    if (typeof callKey !== 'string' || !callKey.length || callKey.length > 128)
      throw this.createError('invalid_call_key');
    return createHash('sha256')
      .update(attribution.executionId + ':' + attribution.operation + ':' + callKey)
      .digest('hex');
  }

  async complete(
    backend: ICompletionBackend,
    model: ModelInfo,
    messages: Parameters<ICompletionBackend['complete']>[1],
    options: Partial<ICompletionOptions>,
    onText: (texts: (string | null | undefined)[]) => Promise<void>,
    callKey?: string
  ): Promise<void> {
    const context = this.context;
    if (!context) throw this.createError('missing_context');
    const reserve = context.persistenceReserveMs ?? 15_000;
    if (!Number.isFinite(context.deadlineAt) || !Number.isFinite(reserve) || reserve < 1)
      throw this.createError('invalid_deadline');
    let cutoff = context.deadlineAt - reserve;
    if (Date.now() >= cutoff) throw this.createError('deadline_exhausted');
    let attribution: IPlatformAttribution;
    try {
      attribution = PlatformAttribution.parse(context.attribution);
    } catch (error) {
      throw this.createError('invalid_attribution', undefined, { cause: error });
    }
    if (model.backend !== ModelBackend.Anthropic && model.backend !== ModelBackend.OpenAI)
      throw this.createError('unsupported_provider');
    const providerCallId = this.createProviderCallId(attribution, callKey);
    const frozenModel = structuredClone(model);
    let attempt;
    let dispatchedAt: Date;
    try {
      const pending = await context.accounting.diagnostics({ limit: 1000, executionId: attribution.executionId });
      if (pending.nextCursor) throw new Error('Platform accounting execution exceeds its attempt limit');
      const existing = pending.attempts.find(item => item.providerCallId === providerCallId);
      if (existing && existing.state !== 'registered') throw this.createError('admission_refused', providerCallId);
      const leaseExpiresAt = existing?.leaseExpiresAt ?? new Date(context.deadlineAt);
      cutoff = Math.min(cutoff, leaseExpiresAt.getTime() - reserve);
      if (Date.now() >= cutoff || cutoff - Date.now() > 2_147_483_647)
        throw this.createError('admission_refused', providerCallId);
      attempt = await context.accounting.register({
        providerCallId,
        attribution,
        provider: frozenModel.backend,
        model: frozenModel.id,
        leaseExpiresAt,
      });
      if (Date.now() >= cutoff) throw this.createError('admission_refused', providerCallId);
      dispatchedAt = new Date();
      if (!(await context.accounting.claimDispatch(providerCallId, dispatchedAt)))
        throw this.createError('admission_refused', providerCallId);
    } catch (error) {
      if (isPlatformCompletionAccountingError(error) && error.reason === 'admission_refused') throw error;
      throw this.createError('admission_failed', providerCallId, { cause: error });
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Platform provider deadline exhausted')),
      Math.max(0, cutoff - Date.now())
    );
    let usage: CompletionInfo | undefined;
    let providerError: unknown;
    let providerFailed = false;
    try {
      if (Date.now() >= cutoff) controller.abort(new Error('Platform provider deadline exhausted'));
      controller.signal.throwIfAborted();
      await backend.complete(
        frozenModel.id,
        messages,
        {
          ...options,
          stream: false,
          tools: undefined,
          executeTools: false,
          retryMode: 'single-attempt',
          abortSignal: controller.signal,
        },
        async (texts, info) => {
          if (info?.inputTokens !== undefined || info?.outputTokens !== undefined || info?.turnUsage) {
            const defined = Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined));
            usage = { ...defined, ...usage };
          }
          await onText(texts);
        }
      );
      controller.signal.throwIfAborted();
    } catch (error) {
      providerFailed = true;
      providerError = error;
    } finally {
      clearTimeout(timer);
    }

    if (!usage || usage.inputTokens === undefined || usage.outputTokens === undefined) {
      try {
        await context.accounting.unresolved(
          providerCallId,
          controller.signal.aborted ? 'aborted_without_usage' : 'missing_usage'
        );
      } catch (error) {
        throw this.createError('unresolved_persistence_failed', providerCallId, { cause: error });
      }
      throw this.createError('provider_usage_unresolved', providerCallId, { cause: providerError });
    }
    let fact;
    try {
      const turn = usage.turnUsage?.length === 1 ? usage.turnUsage[0] : undefined;
      if (usage.turnUsage && usage.turnUsage.length > 1)
        throw new Error('Platform completion used multiple provider attempts');
      fact = pricePlatformUsage({
        attempt: { ...attempt, dispatchedAt },
        model: frozenModel,
        usage: {
          ...usage,
          ...(turn ?? {}),
          inputTokens: turn?.inputTokens ?? usage.inputTokens,
          outputTokens: turn?.outputTokens ?? usage.outputTokens,
        },
        outcome: controller.signal.aborted ? 'timeout' : providerFailed ? 'error' : 'ok',
        completedAt: new Date(),
      });
    } catch (error) {
      try {
        await context.accounting.unresolved(providerCallId, 'missing_usage');
      } catch (persistenceError) {
        throw this.createError('unresolved_persistence_failed', providerCallId, { cause: persistenceError });
      }
      throw this.createError('invalid_provider_usage', providerCallId, { cause: error });
    }
    try {
      await context.accounting.settle(providerCallId, fact);
    } catch (error) {
      throw this.createError('settlement_failed', providerCallId, { cause: error });
    }
    if (providerFailed) throw providerError;
  }
}
