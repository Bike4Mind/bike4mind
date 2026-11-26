import { createHash } from 'node:crypto';
import { PlatformAttribution, type IPlatformAttribution, type ModelInfo } from '@bike4mind/common';
import type { CompletionInfo, ICompletionBackend, ICompletionOptions } from '@bike4mind/llm-adapters';
import { PlatformAccounting, pricePlatformUsage } from '../billing/platformAccounting';

export interface SreAccountingContext {
  accounting: PlatformAccounting;
  attribution: IPlatformAttribution;
  deadlineAt: number;
  persistenceReserveMs?: number;
}

const accountingFailure = Symbol.for('bike4mind.sre.accounting.failure');

export class SreAccountingError extends Error {
  readonly [accountingFailure] = true;
  constructor(
    readonly reason: string,
    readonly providerCallId?: string,
    options?: ErrorOptions
  ) {
    super('SRE accounting requires durable recovery', options);
    this.name = 'SreAccountingError';
  }
}

export function isSreAccountingError(error: unknown): error is SreAccountingError {
  return error instanceof Error && accountingFailure in error && error[accountingFailure] === true;
}

export class SreCompletionMeter {
  private ordinal = 0;

  constructor(private readonly context?: SreAccountingContext) {}

  async complete(
    backend: ICompletionBackend,
    model: ModelInfo,
    messages: Parameters<ICompletionBackend['complete']>[1],
    options: Partial<ICompletionOptions>,
    onText: (texts: (string | null | undefined)[]) => Promise<void>
  ): Promise<void> {
    const context = this.context;
    if (!context) throw new SreAccountingError('missing_context');
    const reserve = context.persistenceReserveMs ?? 15_000;
    if (!Number.isFinite(context.deadlineAt) || !Number.isFinite(reserve) || reserve < 1)
      throw new SreAccountingError('invalid_deadline');
    let cutoff = context.deadlineAt - reserve;
    if (Date.now() >= cutoff) throw new SreAccountingError('deadline_exhausted');
    let attribution: IPlatformAttribution;
    try {
      attribution = PlatformAttribution.parse(context.attribution);
    } catch (error) {
      throw new SreAccountingError('invalid_attribution', undefined, { cause: error });
    }
    const providerCallId = createHash('sha256')
      .update(attribution.executionId + ':sre:' + ++this.ordinal)
      .digest('hex');
    const frozenModel = structuredClone(model);
    let attempt;
    let dispatchedAt: Date;
    try {
      const pending = await context.accounting.diagnostics({ limit: 1000, executionId: attribution.executionId });
      if (pending.nextCursor) throw new Error('SRE accounting execution exceeds its attempt limit');
      const existing = pending.attempts.find(item => item.providerCallId === providerCallId);
      if (existing && existing.state !== 'registered') throw new Error('SRE provider attempt was already dispatched');
      const leaseExpiresAt = existing?.leaseExpiresAt ?? new Date(context.deadlineAt);
      cutoff = Math.min(cutoff, leaseExpiresAt.getTime() - reserve);
      if (Date.now() >= cutoff || cutoff - Date.now() > 2_147_483_647)
        throw new Error('SRE provider deadline exhausted');
      attempt = await context.accounting.register({
        providerCallId,
        attribution,
        provider: frozenModel.backend,
        model: frozenModel.id,
        leaseExpiresAt,
      });
      if (Date.now() >= cutoff) throw new Error('SRE provider deadline exhausted');
      dispatchedAt = new Date();
      if (!(await context.accounting.claimDispatch(providerCallId, dispatchedAt)))
        throw new Error('SRE provider attempt was already dispatched');
    } catch (error) {
      throw new SreAccountingError('admission_failed', providerCallId, { cause: error });
    }

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('SRE provider deadline exhausted')),
      Math.max(0, cutoff - Date.now())
    );
    let usage: CompletionInfo | undefined;
    let providerError: unknown;
    let providerFailed = false;
    try {
      if (Date.now() >= cutoff) controller.abort(new Error('SRE provider deadline exhausted'));
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
        throw new SreAccountingError('unresolved_persistence_failed', providerCallId, { cause: error });
      }
      throw new SreAccountingError('provider_usage_unresolved', providerCallId, { cause: providerError });
    }
    let fact;
    try {
      const turn = usage.turnUsage?.length === 1 ? usage.turnUsage[0] : undefined;
      if (usage.turnUsage && usage.turnUsage.length > 1)
        throw new Error('SRE completion used multiple provider attempts');
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
        throw new SreAccountingError('unresolved_persistence_failed', providerCallId, { cause: persistenceError });
      }
      throw new SreAccountingError('invalid_provider_usage', providerCallId, { cause: error });
    }
    try {
      await context.accounting.settle(providerCallId, fact);
    } catch (error) {
      throw new SreAccountingError('settlement_failed', providerCallId, { cause: error });
    }
    if (providerFailed) throw providerError;
  }
}
