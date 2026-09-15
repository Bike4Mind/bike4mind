import { Request, Response } from 'express';
import { z } from 'zod';
import { baseApi } from '@server/middlewares/baseApi';
import { rateLimit } from '@server/middlewares/rateLimit';
import { ensureAdmin, NotFoundError, BadRequestError, isZodError } from '@server/utils/errors';
import { ModalModel } from '@bike4mind/database/social';
import { MODAL_AUDIENCE_KEY_SET, MODAL_SAFE_DEFAULT_KEY } from '@bike4mind/services';

/**
 * Admin raw-variants authoring endpoint for audience-variant modals.
 *
 * This is the ONE path that returns / writes the raw `variants` map - the
 * serve-time leak guard (`extractVariantForViewer`) is deliberately NOT applied
 * here. Because the guard never runs on this route, it MUST require admin
 * authorization (authentication alone would expose every variant to any
 * signed-in user). The serving route (`/api/modals`) always applies the guard.
 */

const ADMIN_RATE_LIMIT = 20; // requests per minute
const ONE_MINUTE_MS = 60 * 1000;

// Per-variant content. `.strict()` rejects unknown fields so an internal-only
// field can't be smuggled into the map by a malformed request.
const VariantContentSchema = z
  .object({
    title: z.string().max(200).nullish(),
    subtitle: z.string().max(500).nullish(),
    description: z.string().max(15000).nullish(),
  })
  .strict();

const VariantsMapSchema = z.record(z.string(), VariantContentSchema).superRefine((map, ctx) => {
  if (Object.keys(map).length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'variants map must contain at least one audience key',
    });
    return;
  }
  for (const key of Object.keys(map)) {
    if (!MODAL_AUDIENCE_KEY_SET.has(key)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown audience key "${key}". Valid keys: ${[...MODAL_AUDIENCE_KEY_SET].join(', ')}`,
        path: [key],
      });
    }
  }
});

const UpdateVariantsSchema = z.object({
  modalId: z.string().min(1, 'modalId is required'),
  variants: VariantsMapSchema,
});

const ModalIdBodySchema = z.object({ modalId: z.string().min(1, 'modalId is required') });

function zodResponse(res: Response, error: unknown): Response | null {
  if (!isZodError(error)) return null;
  const issues = (error as { issues: Array<{ path: (string | number)[]; message: string }> }).issues.map(i => {
    const field = i.path.join('.');
    return field ? `${field}: ${i.message}` : i.message;
  });
  return res.status(400).json({ error: 'Invalid request', details: issues, validationErrors: issues });
}

const handler = baseApi()
  .use(rateLimit({ limit: ADMIN_RATE_LIMIT, windowMs: ONE_MINUTE_MS }))
  // Read the full modal INCLUDING its raw variants map (for admin editing).
  .get(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);
    const modalId = typeof req.query.modalId === 'string' ? req.query.modalId : '';
    if (!modalId) throw new BadRequestError('modalId query param is required');

    const modal = await ModalModel.findById(modalId).lean();
    if (!modal) throw new NotFoundError('Modal not found');

    // Return the document unextracted - the leak guard is intentionally not run here.
    return res.json(modal);
  })
  // Create or replace the variants map for a modal.
  .put(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);
    try {
      const { modalId, variants } = UpdateVariantsSchema.parse(req.body);

      // Mirror the customer slice to top-level so legacy/unclassified readers
      // and style-learning queries always see the customer floor, not stale data.
      const customerSlice = variants[MODAL_SAFE_DEFAULT_KEY];
      const topLevelSync: Record<string, string | null | undefined> = {};
      if (customerSlice) {
        if (customerSlice.title !== undefined) topLevelSync.title = customerSlice.title ?? '';
        if (customerSlice.subtitle !== undefined) topLevelSync.subtitle = customerSlice.subtitle ?? '';
        if (customerSlice.description !== undefined) topLevelSync.description = customerSlice.description ?? '';
      }

      const updated = await ModalModel.findByIdAndUpdate(
        modalId,
        { $set: { variants, ...topLevelSync } },
        { new: true, runValidators: true }
      ).lean();
      if (!updated) throw new NotFoundError('Modal not found');

      return res.json({ success: true, modal: updated });
    } catch (error) {
      const zr = zodResponse(res, error);
      if (zr) return zr;
      throw error;
    }
  })
  // Clear the variants map (revert the modal to legacy single-content mode).
  .delete(async (req: Request, res: Response) => {
    ensureAdmin(req.user?.isAdmin);
    try {
      const { modalId } = ModalIdBodySchema.parse(req.body);

      // Read existing variants before clearing. An internal-only modal (variants
      // map present but no customer key) has raw internal text at top-level.
      // Clearing variants reverts the doc to legacy mode, so any subsequent
      // edit-path S3 sync would upload that internal text to fork environments.
      // Reset content fields on those modals to prevent the leak.
      const existing = await ModalModel.findById(modalId).lean();
      if (!existing) throw new NotFoundError('Modal not found');

      const existingVariants = existing.variants as Record<string, unknown> | undefined | null;
      const hadCustomerVariant = !existingVariants || MODAL_SAFE_DEFAULT_KEY in (existingVariants ?? {});

      const updateOp = hadCustomerVariant
        ? { $unset: { variants: '' } }
        : { $unset: { variants: '' }, $set: { title: '', subtitle: '', description: '' } };

      const updated = await ModalModel.findByIdAndUpdate(modalId, updateOp, { new: true }).lean();
      if (!updated) throw new NotFoundError('Modal not found');

      return res.json({ success: true, modal: updated });
    } catch (error) {
      const zr = zodResponse(res, error);
      if (zr) return zr;
      throw error;
    }
  });

export default handler;

export const config = {
  api: {
    externalResolver: true,
  },
};
