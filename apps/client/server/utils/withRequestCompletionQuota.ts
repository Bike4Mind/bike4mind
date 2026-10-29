import type { Request, Response } from 'express';
import { admitRequestCompletion } from '@server/utils/untrustedCompletionQuota';

export type CompletionQuotaContext = {
  /** A provider may outlive a best-effort timeout response and must retain its slot. */
  track<T>(completion: Promise<T>): Promise<T>;
};

/** Keeps operational model calls under the same account quotas as public completions. */
export function withRequestCompletionQuota<TRequest extends Request, TResult>(
  complete: (req: TRequest, res: Response, quotaContext: CompletionQuotaContext) => Promise<TResult>
): (req: TRequest, res: Response) => Promise<TResult> {
  return async (req, res) => {
    const quota = await admitRequestCompletion(req, { holdSlot: true });
    let pendingCompletions = 0;
    let handlerSettled = false;
    const completionSettled = () => {
      pendingCompletions -= 1;
      if (handlerSettled && pendingCompletions === 0) void quota.release();
    };
    const quotaContext: CompletionQuotaContext = {
      track: completion => {
        pendingCompletions += 1;
        void completion.then(completionSettled, completionSettled);
        return completion;
      },
    };
    try {
      return await complete(req, res, quotaContext);
    } finally {
      handlerSettled = true;
      if (pendingCompletions === 0) await quota.release();
    }
  };
}
