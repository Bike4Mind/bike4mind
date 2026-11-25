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
  /** The look is still in its upload safety check, so takes wait for it to clear. */
  checking?: boolean;
};

/**
 * Looks already saved to a brand kit. In memory like the storyboard's reorder guard, so a re-call that resumes on
 * another container forgets it and a removed look comes back (best effort).
 */
const SAVED_LOOKS_MAX = 1_000;
const savedLooks = new Set<string>();

const markSaved = (fileId: string): void => {
  savedLooks.add(fileId);
  // Sets iterate in insertion order, so this drops the oldest look.
  const oldest = savedLooks.values().next();
  if (savedLooks.size > SAVED_LOOKS_MAX && !oldest.done) savedLooks.delete(oldest.value);
};

/**
 * Makes one packshot from the brief for a production with no product image, and saves it at the front of the brand
 * kit so later takes and the next direct reference it instead of making another. A skipped or failed look leaves the
 * shots to start without a reference; a look still running holds them until a re-call attaches to it.
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
    // A look the image job would refuse (e.g. moderation-blocked) is never saved or waited on. Checked before the
    // saved-look guard, since a look saved during its safety check and blocked later is still in the kit.
    const state = (await config.referenceImages([fileId])).get(fileId);
    if (!state) return { references: [], status: 'failed: the product look cannot be used as a reference' };
    // The job is keyed per Quest, so a re-call after the user took a saved look out of the kit replays it; saving it
    // again would bring the removed image back. A look that finished after an earlier call stopped waiting is saved.
    if (savedLooks.has(fileId)) {
      return { references: [], status: 'skipped: the look made earlier in this run is no longer in the brand kit' };
    }
    // Read again: the user may have edited the brand kit while the look was being made.
    const fresh = await config.compositions.get(composition.id);
    await config.compositions.update(composition.id, {
      brandKit: { ...fresh.brandKit, productFileIds: withProductLook(fresh.brandKit.productFileIds, fileId) },
    });
    markSaved(fileId);
    return { references: [fileId], status: 'made', checking: state === 'checking' };
  }
  const outcome = jobOutcome(job);
  if (outcome.startsWith('still')) return { references: [], status: 'pending', pendingJobId: jobId };
  return { references: [], status: `failed: ${outcome}` };
}
