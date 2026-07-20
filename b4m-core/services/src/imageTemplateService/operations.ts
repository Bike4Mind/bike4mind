import type {
  IImageGenerationTemplateDocument,
  IImageTemplateCaller,
  ImageGenerationTemplateInputType,
  ImageGenerationTemplateUpdateInputType,
} from '@bike4mind/common';
import {
  IMAGE_TEMPLATES_PER_USER_MAX,
  NotFoundError,
  UnprocessableEntityError,
  canonicalizeTemplateSettings,
} from '@bike4mind/common';
import type { ImageTemplateServiceAdapters } from './ports';
import { assertAuthenticated, assertInteractive } from './access';

/**
 * Image-template operations. Pure functions of (caller, adapters, args) - no
 * framework/DB import - mirroring the briefcaseService shape. Ownership is bound
 * to `caller.id` resolved server-side; a client never names another user.
 */

/** List the caller's templates (usageCount desc, then newest). API keys get nothing. */
export async function listTemplates(
  caller: IImageTemplateCaller,
  { db }: ImageTemplateServiceAdapters,
  page: { limit: number; skip?: number }
): Promise<IImageGenerationTemplateDocument[]> {
  assertAuthenticated(caller);
  if (caller.isApiKey) return [];
  return db.templates.listOwned(caller.id, page.limit, page.skip ?? 0);
}

/** Fetch one owned template. 404 if missing or not owned (never another user's). */
export async function getTemplate(
  caller: IImageTemplateCaller,
  { db }: ImageTemplateServiceAdapters,
  id: string
): Promise<IImageGenerationTemplateDocument> {
  assertAuthenticated(caller);
  assertInteractive(caller);
  const tpl = await db.templates.findOwned(id, caller.id);
  if (!tpl) throw new NotFoundError('Template not found');
  return tpl;
}

/** Create a template owned by the caller. Enforces the per-user cap. */
export async function saveTemplate(
  caller: IImageTemplateCaller,
  { db }: ImageTemplateServiceAdapters,
  input: ImageGenerationTemplateInputType
): Promise<IImageGenerationTemplateDocument> {
  assertAuthenticated(caller);
  assertInteractive(caller);

  // Reject an exact-settings duplicate for this model (regardless of name), so the
  // same config isn't saved twice under different names.
  const incoming = canonicalizeTemplateSettings(input.settings);
  const siblings = await db.templates.listByModel(caller.id, input.model);
  const duplicate = siblings.find(t => canonicalizeTemplateSettings(t.settings) === incoming);
  if (duplicate) {
    throw new UnprocessableEntityError(`You already have a template with these settings ("${duplicate.name}").`);
  }

  // Soft cap: count-then-create is not atomic, so tightly-concurrent creates can
  // briefly overshoot the cap. Acceptable for M1 (bounded by the create rate
  // limit; no correctness impact beyond a few extra rows) - revisit with an
  // atomic guard only if abuse shows up.
  const count = await db.templates.countOwned(caller.id);
  if (count >= IMAGE_TEMPLATES_PER_USER_MAX) {
    throw new UnprocessableEntityError(
      `You have reached the limit of ${IMAGE_TEMPLATES_PER_USER_MAX} image templates. Delete one to save another.`
    );
  }

  return db.templates.create({
    ...input,
    userId: caller.id, // server-bound ownership - never from the request body
    usageCount: 0,
    deletedAt: null,
  } as Parameters<typeof db.templates.create>[0]);
}

/** Update an owned template. 404 if missing or not owned. */
export async function updateTemplate(
  caller: IImageTemplateCaller,
  { db }: ImageTemplateServiceAdapters,
  id: string,
  patch: ImageGenerationTemplateUpdateInputType
): Promise<IImageGenerationTemplateDocument> {
  assertAuthenticated(caller);
  assertInteractive(caller);
  const updated = await db.templates.updateOwned(id, caller.id, patch);
  if (!updated) throw new NotFoundError('Template not found');
  return updated;
}

/** Soft-delete an owned template. 404 if missing or not owned. */
export async function deleteTemplate(
  caller: IImageTemplateCaller,
  { db }: ImageTemplateServiceAdapters,
  id: string
): Promise<void> {
  assertAuthenticated(caller);
  assertInteractive(caller);
  const deleted = await db.templates.softDeleteOwned(id, caller.id);
  if (!deleted) throw new NotFoundError('Template not found');
}

/**
 * Record a use of an owned template: bump usageCount. Called when a prompt is
 * sent with the template's settings (matched client-side), so usageCount reflects
 * actual usage rather than merely applying a template. Applying is purely
 * client-side (load its settings), so there is no server apply endpoint.
 */
export async function recordUse(
  caller: IImageTemplateCaller,
  { db }: ImageTemplateServiceAdapters,
  id: string
): Promise<void> {
  assertAuthenticated(caller);
  assertInteractive(caller);
  const updated = await db.templates.incrementUsage(id, caller.id);
  if (!updated) throw new NotFoundError('Template not found');
}
