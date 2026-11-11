/**
 * Bulk settle for the Model lifecycle queue: one shared note, one confirm, and
 * then one ordinary POST per row.
 *
 * A loop over the single-row route rather than a batch endpoint, on purpose:
 * each row keeps its own audit-log entry, its own catalog row and its own
 * auto-remap check with no second implementation to drift from the first. The
 * requests run one at a time because every accept bumps the model-list
 * revision, and a queue of ~70 is seconds of wall-clock, not minutes.
 *
 * A 409 `replacement-blocked` is reported back for that row and never retried
 * with acknowledgeBlockers: overruling the automation stays a per-row decision
 * taken in the single-row Accept dialog.
 */

export type BulkAction = 'accept' | 'dismiss';

export type BulkRowResult =
  | { modelId: string; outcome: 'settled' }
  | { modelId: string; outcome: 'blocked'; blockers: string[] }
  | { modelId: string; outcome: 'failed'; message: string };

export type BulkPost = (body: Record<string, unknown>) => Promise<unknown>;

type ErrorShape = {
  response?: { status?: number; data?: { code?: string; details?: string[]; message?: string } };
  message?: string;
};

const isErrorShape = (error: unknown): error is ErrorShape => typeof error === 'object' && error !== null;

function classify(modelId: string, error: unknown): BulkRowResult {
  const shaped = isErrorShape(error) ? error : undefined;
  const response = shaped?.response;
  if (response?.status === 409 && response.data?.code === 'replacement-blocked') {
    return {
      modelId,
      outcome: 'blocked',
      blockers: response.data.details?.length ? response.data.details : ['the automation refused this successor'],
    };
  }
  return { modelId, outcome: 'failed', message: response?.data?.message || shaped?.message || 'Request failed' };
}

/**
 * Settles each model in order and reports every row's outcome. One row's
 * failure never stops the rest: the operator gets the full list back.
 */
export async function runBulkResolution(options: {
  modelIds: readonly string[];
  action: BulkAction;
  note: string;
  post: BulkPost;
  onProgress?: (done: number, total: number) => void;
}): Promise<BulkRowResult[]> {
  const { modelIds, action, post, onProgress } = options;
  const note = options.note.trim();
  // The route enforces this too; failing here keeps a blank note from producing 70 identical 400s.
  if (action === 'accept' && !note) throw new Error('A note is required to accept: it is the audit trail.');

  const results: BulkRowResult[] = [];
  for (const modelId of modelIds) {
    try {
      // No replacedBy and never acknowledgeBlockers: each row is accepted as suggested or not at all.
      // A dismiss carries the note only when there is one; the route records it in the audit entry.
      await post({ modelId, action, ...(note ? { note } : {}) });
      results.push({ modelId, outcome: 'settled' });
    } catch (error) {
      results.push(classify(modelId, error));
    }
    onProgress?.(results.length, modelIds.length);
  }
  return results;
}
