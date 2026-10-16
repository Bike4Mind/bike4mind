import type { IMessage, ModelInfo } from '@bike4mind/common';
import type { CompletionInfo, ICompletionBackend } from '@bike4mind/llm-adapters';
import { BadRequestError, DEFAULT_OUTPUT_MAX_TOKENS } from '@bike4mind/utils';

export type CompletionUsage = Pick<
  CompletionInfo,
  'inputTokens' | 'outputTokens' | 'cacheReadInputTokens' | 'cacheCreationInputTokens' | 'turnUsage'
>;

/**
 * One reserved completion: settle on success (charges the usage, or the hold when none was reported),
 * refund on a throw that came before any usage was reported.
 */
export type MeteredCompletion = {
  settle(usage: CompletionUsage): Promise<number>;
  refund(): Promise<void>;
};

/**
 * Admits `modelInfo` and reserves the worst-case cost of one call before the provider is called.
 * Throws (422 insufficient_credits, or the admission refusal) without reserving anything. Injected
 * into b4m-core services that run platform-key completions outside a request; the implementation
 * is createCompletionMeter in apps/client/server/billing/meterPlatformCompletion.ts.
 */
export type CompletionMeter = (
  modelInfo: ModelInfo,
  messages: IMessage[],
  maxTokens: number,
  models?: ModelInfo[]
) => Promise<MeteredCompletion>;

/** Latch each usage field from whichever chunk carries it (same contract as cliCompletions). */
export function latchUsage(usage: CompletionUsage, info?: CompletionInfo): void {
  if (info?.inputTokens) usage.inputTokens = info.inputTokens;
  if (info?.outputTokens) usage.outputTokens = info.outputTokens;
  if (info?.cacheReadInputTokens) usage.cacheReadInputTokens = info.cacheReadInputTokens;
  if (info?.cacheCreationInputTokens) usage.cacheCreationInputTokens = info.cacheCreationInputTokens;
  if (info?.turnUsage?.length) usage.turnUsage = info.turnUsage;
}

function hasReportedUsage(usage: CompletionUsage): boolean {
  return Boolean(
    usage.inputTokens ||
    usage.outputTokens ||
    usage.cacheReadInputTokens ||
    usage.cacheCreationInputTokens ||
    usage.turnUsage?.length
  );
}

/**
 * Run `call` under a meter: settle on success; on failure, settle the usage already reported (the
 * provider billed it, e.g. when the caller's stream callback threw) or refund when there is none, then rethrow.
 * Without a meter the call runs unmetered (hosts that do not bill, e.g. tests and self-host CLIs).
 */
export async function withMeteredCompletion<T>(
  metered: MeteredCompletion | undefined,
  usage: CompletionUsage,
  call: () => Promise<T>
): Promise<T> {
  let result: T;
  try {
    result = await call();
  } catch (err) {
    if (hasReportedUsage(usage)) await metered?.settle(usage);
    else await metered?.refund();
    throw err;
  }
  await metered?.settle(usage);
  return result;
}

/**
 * Meter every top-level `complete` call on `llm`: each one is admitted and reserved before the
 * provider is called, and settled from its reported usage (refunded on a throw before any). For callers
 * that hand one backend to code making many calls (deep-agent wakes, background extraction).
 * Tool round-trips the adapter runs inside one `complete` settle with that call via turnUsage.
 */
export function meterCompletionBackend<T extends Pick<ICompletionBackend, 'complete'>>(
  llm: T,
  meter: CompletionMeter,
  modelInfo: ModelInfo,
  models?: ModelInfo[]
): T {
  const complete: ICompletionBackend['complete'] = async (model, messages, options, callback) => {
    // A bound model set is the admitted set: pricing an unlisted id as modelInfo would undercharge it.
    const callModel = models ? models.find(m => m.id === model) : modelInfo;
    if (!callModel) throw new BadRequestError(`Model "${model}" is not in the metered model set`);
    const metered = await meter(callModel, messages, options.maxTokens ?? DEFAULT_OUTPUT_MAX_TOKENS, models);
    const usage: CompletionUsage = {};
    return withMeteredCompletion(metered, usage, () =>
      llm.complete(model, messages, options, async (text, info) => {
        latchUsage(usage, info);
        await callback(text, info);
      })
    );
  };
  return new Proxy(llm, {
    get(target, prop, receiver) {
      if (prop === 'complete') return complete;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
