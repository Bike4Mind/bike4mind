import { withProductLook } from '@bike4mind/common';
import type { ToolContext } from '../../base/types';
import type { ProductionComposition, ProductionToolConfig } from './config';
import { buildPackshotPrompt, jobOutcome, submitShotImages, waitForJobs } from './jobs';

type Context = Omit<ToolContext, 'config'>;

export type ProductLook = {
  /** The look to reference, or none when it was skipped, failed, or is still running. */
  references: string[];
  status: 'made' | 'pending' | `failed: ${string}` | `skipped: ${string}`;
  /** The look's job when it is still running; a re-call attaches to it instead of paying again. */
  pendingJobId?: string;
};

/**
 * Makes one packshot from the brief for a production with no product image, and saves it at the front of the brand
 * kit so later takes and the next direct reference it instead of making another. Never blocks the shots: a skipped
 * or failed look leaves them to start without a reference.
 */
export async function ensureProductLook(
  context: Context,
  config: ProductionToolConfig,
  composition: ProductionComposition
): Promise<ProductLook> {
  const summary = composition.brief.summary?.trim();
  if (!summary) return { references: [], status: 'skipped: the brief has no summary to draw the product from' };
  if (!config.image) return { references: [], status: 'skipped: image generation is not available for this run' };

  const submitted = await submitShotImages(
    context,
    config,
    {
      prompt: buildPackshotPrompt(summary),
      references: [],
      aspectRatio: '1:1',
      compositionId: composition.id,
      purpose: 'product-look',
    },
    1
  );
  if (!submitted.ok) return { references: [], status: `failed: ${submitted.message}` };
  const jobId = submitted.jobIds[0] as string;
  const job = (await waitForJobs(config, [jobId], context.getAbortSignal?.())).get(jobId);
  if (job?.state === 'succeeded' && job.fileId) {
    const fileId = job.fileId;
    // Read again: the user may have edited the brand kit while the look was being made.
    const fresh = await config.compositions.get(composition.id);
    await config.compositions.update(composition.id, {
      brandKit: { ...fresh.brandKit, productFileIds: withProductLook(fresh.brandKit.productFileIds, fileId) },
    });
    return { references: [fileId], status: 'made' };
  }
  const outcome = jobOutcome(job);
  if (outcome.startsWith('still')) return { references: [], status: 'pending', pendingJobId: jobId };
  return { references: [], status: `failed: ${outcome}` };
}
