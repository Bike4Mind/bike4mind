import { IBaseRepository, IMongoDocument } from '.';
import type { ImageTemplateSettingsType } from '../../schemas/imageGenerationTemplate';

/**
 * Image-generation template - a userId-scoped, reusable snapshot of the
 * image-mode settings, bound to exactly one model (EXACT-MODEL compatibility).
 *
 * Separate model from BriefcasePrompt: this stores a SETTINGS blob applied to
 * LLMContext (sending nothing), not prompt text delivered into the composer.
 * The architecture (port-based service, server-bound ownership, query-scoped
 * mutations) mirrors the briefcase blueprint.
 */
export interface IImageGenerationTemplate {
  /** Owner. Always set - templates are personal (no shared/system templates in M1). */
  userId: string;
  /** Human-facing display name shown in the picker. */
  name: string;
  /** Optional short description. */
  description?: string;
  /** Optional grouping label (free text). */
  category?: string;
  /** The model this template is bound to. Apply is exact-model only. */
  model: string;
  /** Captured image-mode settings (model-conditional; valid for `model`). */
  settings: ImageTemplateSettingsType;
  /** Server-managed. Incremented on apply; used only for default sort ordering. */
  usageCount?: number;
  /** Soft-delete marker (set by the soft-delete plugin). */
  deletedAt?: Date | null;
}

/** A persisted template: IImageGenerationTemplate plus the store's identity. */
export interface IImageGenerationTemplateDocument extends IImageGenerationTemplate, IMongoDocument {}

export interface IImageGenerationTemplateRepository extends IBaseRepository<IImageGenerationTemplateDocument> {
  /** The caller's templates, newest-used first (usageCount desc, then createdAt desc). Paginated. */
  listOwned(userId: string, limit: number, skip?: number): Promise<IImageGenerationTemplateDocument[]>;
  /** Count of the caller's non-deleted templates (for the per-user cap). */
  countOwned(userId: string): Promise<number>;
  /** A single template by id, only if owned by the caller. Null otherwise - never another user's. */
  findOwned(id: string, userId: string): Promise<IImageGenerationTemplateDocument | null>;
  /** Update a template only if owned by the caller. Returns null if not owned. */
  updateOwned(
    id: string,
    userId: string,
    patch: Partial<IImageGenerationTemplate>
  ): Promise<IImageGenerationTemplateDocument | null>;
  /** Soft-delete a template only if owned by the caller. Returns true if deleted. */
  softDeleteOwned(id: string, userId: string): Promise<boolean>;
  /** Increment usageCount by 1 and return the fresh doc, only if owned. Null otherwise. */
  incrementUsage(id: string, userId: string): Promise<IImageGenerationTemplateDocument | null>;
}

/**
 * The authenticated caller, resolved server-side from session/framework context
 * - never from client-supplied parameters. Mirrors the briefcase ICaller.
 */
export interface IImageTemplateCaller {
  id: string;
  isAdmin: boolean;
  /** True when authenticated via an API key, not an interactive session. */
  isApiKey?: boolean;
}
