import { z } from 'zod';
import type { IModelPriceTier, ModelPriceUnit } from '../types/entities/ModelPriceTypes';

/** The admin model list, GET /api/admin/models. Status and reason vocabulary: docs/admin-models-spec.md section 4. */
export const ADMIN_MODEL_STATUSES = ['listed', 'limited', 'needs-review', 'hidden', 'retiring', 'retired'] as const;
export type AdminModelStatus = (typeof ADMIN_MODEL_STATUSES)[number];

/**
 * Listed covers Limited and Retiring covers Retired. Needs review also covers any pending lifecycle suggestion, and
 * Retiring any model in the retiring window (ADMIN_MODEL_RETIRING_HORIZON_DAYS), whatever the model's status.
 */
export const ADMIN_MODEL_VIEWS = ['all', 'needs-review', 'listed', 'hidden', 'retiring'] as const;
export type AdminModelView = (typeof ADMIN_MODEL_VIEWS)[number];

/** `admin` matches any model with an operator catalog row in force, whatever its origin. */
export const ADMIN_MODEL_SOURCES = ['default', 'discovered', 'admin'] as const;
export type AdminModelSource = (typeof ADMIN_MODEL_SOURCES)[number];

/** In the order an admin should fix them; a model's reasons are sorted by this order. */
export const ADMIN_MODEL_REASON_CODES = [
  'admin-off',
  'admin-off-before-promotion',
  'operator-disabled',
  'build-disabled',
  'price-none',
  'price-missing',
  'price-aggregator-quote',
  'awaiting-discovery-run',
  'price-no-build-literal',
  'manual-approval-required',
  'lifecycle-suggestion',
  'source-not-on-demand',
  'source-not-entitled',
  'source-disabled',
  'no-credential-for-backend',
  'not-callable',
  'missing-context-window',
  'private',
] as const;
export type AdminModelReasonCode = (typeof ADMIN_MODEL_REASON_CODES)[number];

/** Reasons an admin resolves in the console; any other reason makes the model Hidden. */
export const ADMIN_MODEL_NEEDS_REVIEW_REASONS: ReadonlySet<AdminModelReasonCode> = new Set<AdminModelReasonCode>([
  'price-none',
  'price-missing',
  'price-aggregator-quote',
  'awaiting-discovery-run',
  'manual-approval-required',
  'lifecycle-suggestion',
]);

export const ADMIN_MODEL_FIX_ACTIONS = [
  'turn-on',
  'add-price',
  'run-discovery',
  'review-lifecycle',
  'open-key-settings',
] as const;
export type AdminModelFixAction = (typeof ADMIN_MODEL_FIX_ACTIONS)[number];

/** `sunset` orders by sunsetDays: most overdue first, undated models last. */
export const ADMIN_MODEL_SORTS = ['status', 'name', 'rank', 'type', 'provider', 'sunset'] as const;
export type AdminModelSort = (typeof ADMIN_MODEL_SORTS)[number];

/**
 * Days ahead a deprecation or retirement date puts a model in the retiring window, as does a date already past or a
 * deprecated or retired lifecycle. Such a model reads Retiring unless it is Retired or a reason outranks it.
 */
export const ADMIN_MODEL_RETIRING_HORIZON_DAYS = 90;

/**
 * The list's server-side filter. The list and the bulk access `{ filter }` selection both resolve through it, so a
 * selection covers exactly the models the admin saw, including the default exclusion of profile-only Bedrock
 * foundation ids (`showFoundationIds`).
 */
export const AdminModelFilterSchema = z
  .object({
    view: z.enum(ADMIN_MODEL_VIEWS).default('all'),
    /** Case-insensitive substring of the model id or name. */
    search: z.string().trim().max(200).optional(),
    /** Backend ids (ModelBackend values). */
    providers: z.array(z.string().min(1).max(64)).max(32).optional(),
    types: z.array(z.string().min(1).max(64)).max(16).optional(),
    sources: z.array(z.enum(ADMIN_MODEL_SOURCES)).max(ADMIN_MODEL_SOURCES.length).optional(),
    showFoundationIds: z.boolean().default(false),
  })
  .strict();
export type AdminModelFilter = z.input<typeof AdminModelFilterSchema>;
export type ResolvedAdminModelFilter = z.output<typeof AdminModelFilterSchema>;

export interface AdminModelReason {
  code: AdminModelReasonCode;
  message: string;
  /** Only actions that exist today; absent means the console cannot fix it. */
  fixAction?: AdminModelFixAction;
  /** The stored or source text the reason was mapped from, when it adds anything to `message`. */
  detail?: string;
}

/** The access fields of the model's llmModelConfigurations entry. */
export interface AdminModelAccessEntry {
  enabled: boolean;
  allowedUserTags: string[];
  allowedEntitlements: string[];
  fallbackModel?: string;
  rank?: number;
  /** ISO time the entry was last written, once entries carry it. */
  updatedAt?: string;
}

export interface AdminModelAccess {
  /** Null when the model has no entry, which leaves it unrestricted. */
  entry: AdminModelAccessEntry | null;
  /** Every signed-in user can pick it: no entry, or an entry granting the base entitlement. */
  everyone: boolean;
  /** Enabled with no tags and no entitlements: only admins see it. */
  adminsOnly: boolean;
  /** The free-tier gate is on and this model is not on its allowlist. */
  freeTierLocked: boolean;
}

export type AdminModelPrice =
  | {
      source: 'row';
      unit: ModelPriceUnit;
      pricing: Record<string, IModelPriceTier>;
      effectiveFrom: string;
      note?: string;
      rowId?: string;
    }
  /** The adapter literal this build ships ("Build table"). */
  | { source: 'build'; pricing: Record<string, IModelPriceTier> };

export interface AdminModelLifecycle {
  status?: string;
  deprecationDate?: string;
  retirementDate?: string;
  replacedBy?: string;
}

export interface AdminModelLifecycleSuggestion extends AdminModelLifecycle {
  source: string;
  detail?: string;
  suggestedAt: string;
}

export interface AdminModelRow {
  id: string;
  name: string;
  type: string;
  backend: string;
  vendor?: string;
  description?: string;
  contextWindow?: number;
  releaseDate?: string;
  private: boolean;
  freeToRun: boolean;
  status: AdminModelStatus;
  reasons: AdminModelReason[];
  /**
   * Its rank in the web picker's provider section (pickerProviderGroup): the access entry's, else the catalog's, else
   * provisionalRank over the section's pickable models. A provisional rank approximates the picker's, which first
   * dedupes twins, dated snapshots and profiles per viewer. Null for an unranked model the picker does not offer.
   */
  rank: number | null;
  /** Neither the access entry nor the catalog ranks it; `rank` is provisional (approximate), or null. */
  rankProvisional: boolean;
  /** `default`: an adapter literal or seed row ships it; `discovered`: only discovery knows it; `admin`: only operator rows. */
  origin: AdminModelSource;
  /** An operator catalog row is in force for it. */
  adminEdited: boolean;
  /** This environment holds a credential for its backend. */
  keyPresent: boolean;
  access: AdminModelAccess;
  price: AdminModelPrice | null;
  lifecycle: AdminModelLifecycle;
  /** The sooner of lifecycle.deprecationDate and lifecycle.retirementDate (YYYY-MM-DD); null when it has neither. */
  sunsetDate: string | null;
  /** Whole UTC days from today to sunsetDate, zero or less once it has arrived; null when sunsetDate is. */
  sunsetDays: number | null;
  lifecycleSuggestion: AdminModelLifecycleSuggestion | null;
  /** First discovery row for the model; null when discovery never recorded it. */
  firstSeenAt: string | null;
  /** A Bedrock foundation id served only through an inference profile; the default views leave it out. */
  profileOnlyFoundation: boolean;
}

export interface AdminModelListResponse {
  models: AdminModelRow[];
  /** Models matching the whole filter, across pages. */
  total: number;
  page: number;
  pageSize: number;
  /** Per status, over every filter except the view. */
  counts: Record<AdminModelStatus, number>;
  /** Per view tab, over every filter except the view; a view can span statuses. */
  viewCounts: Record<AdminModelView, number>;
  /** Profile-only Bedrock foundation ids matching the other filters: what the foundation-ids chip shows or restores. */
  foundationIds: number;
  /** Values present across every model, for the filter menus. */
  facets: { providers: string[]; types: string[] };
}
