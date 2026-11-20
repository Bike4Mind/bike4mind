import mongoose, { Model, model, Schema, Types } from 'mongoose';

/**
 * An admin's saved list view (filters, sort, page size, grouping) for one admin list. The `view`
 * payload is versioned and validated by the client contract in
 * apps/client/app/utils/adminSavedViews.ts, so it is stored as Mixed here.
 */

/** Must stay in sync with ADMIN_SAVED_VIEW_SURFACES in apps/client/app/utils/adminSavedViews.ts. */
export const ADMIN_SAVED_VIEW_SURFACES = ['users'] as const;
export type AdminSavedViewSurface = (typeof ADMIN_SAVED_VIEW_SURFACES)[number];

export const ADMIN_SAVED_VIEW_NAME_MAX_LENGTH = 60;

type AdminSavedViewDocumentShape = {
  _id: Types.ObjectId;
  ownerId: Types.ObjectId;
  surface: AdminSavedViewSurface;
  name: string;
  shared: boolean;
  view: unknown;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminSavedViewRecord = {
  id: string;
  ownerId: string;
  surface: AdminSavedViewSurface;
  name: string;
  shared: boolean;
  /** Unvalidated: the reader parses it against the surface's versioned schema. */
  view: unknown;
  createdAt: Date;
  updatedAt: Date;
};

const AdminSavedViewSchema = new Schema<AdminSavedViewDocumentShape>(
  {
    ownerId: { type: Schema.Types.ObjectId, required: true },
    surface: { type: String, enum: ADMIN_SAVED_VIEW_SURFACES, required: true },
    name: { type: String, required: true, trim: true, minlength: 1, maxlength: ADMIN_SAVED_VIEW_NAME_MAX_LENGTH },
    shared: { type: Boolean, required: true, default: false },
    view: { type: Schema.Types.Mixed, required: true },
  },
  { collection: 'adminsavedviews', timestamps: true, minimize: false }
);

// One name per admin per list; the unique index is what makes a concurrent duplicate fail.
AdminSavedViewSchema.index({ ownerId: 1, surface: 1, name: 1 }, { unique: true });
// The shared half of the list query ($or with the owner's own views).
AdminSavedViewSchema.index({ surface: 1, shared: 1 });

export const AdminSavedView: Model<AdminSavedViewDocumentShape> =
  (mongoose.models.AdminSavedView as Model<AdminSavedViewDocumentShape> | undefined) ??
  model<AdminSavedViewDocumentShape>('AdminSavedView', AdminSavedViewSchema);

const toRecord = (document: AdminSavedViewDocumentShape): AdminSavedViewRecord => ({
  id: String(document._id),
  ownerId: String(document.ownerId),
  surface: document.surface,
  name: document.name,
  shared: document.shared,
  view: document.view,
  createdAt: document.createdAt,
  updatedAt: document.updatedAt,
});

export type AdminSavedViewCreate = {
  ownerId: string;
  surface: AdminSavedViewSurface;
  name: string;
  shared: boolean;
  view: unknown;
};

export type AdminSavedViewPatch = Partial<Pick<AdminSavedViewRecord, 'name' | 'shared' | 'view'>>;

/** Bounded separately so other admins' shared views can never crowd the owner's own views out. */
export type AdminSavedViewListLimits = { owned: number; shared: number };

export type IAdminSavedViewRepository = {
  /** The owner's views plus other admins' shared views on `surface`, by name. */
  listVisible: (
    ownerId: string,
    surface: AdminSavedViewSurface,
    limits: AdminSavedViewListLimits
  ) => Promise<AdminSavedViewRecord[]>;
  countOwned: (ownerId: string, surface: AdminSavedViewSurface) => Promise<number>;
  /** Throws a duplicate-key error (11000) when the owner already has a view by that name. */
  create: (input: AdminSavedViewCreate) => Promise<AdminSavedViewRecord>;
  /** Null when no such view belongs to `ownerId`. A rename onto a taken name throws 11000. */
  updateOwned: (id: string, ownerId: string, patch: AdminSavedViewPatch) => Promise<AdminSavedViewRecord | null>;
  /** False when no such view belongs to `ownerId`. */
  deleteOwned: (id: string, ownerId: string) => Promise<boolean>;
};

// Ids reach here already checked as ObjectId hex by the route, so the casts cannot throw.
class AdminSavedViewRepository implements IAdminSavedViewRepository {
  constructor(private readonly savedViewModel: Model<AdminSavedViewDocumentShape>) {}

  async listVisible(
    ownerId: string,
    surface: AdminSavedViewSurface,
    limits: AdminSavedViewListLimits
  ): Promise<AdminSavedViewRecord[]> {
    const owner = new Types.ObjectId(ownerId);
    const byName = { name: 1, _id: 1 } as const;
    const [owned, shared] = await Promise.all([
      this.savedViewModel
        .find({ ownerId: owner, surface })
        .sort(byName)
        .limit(limits.owned)
        .lean<AdminSavedViewDocumentShape[]>(),
      this.savedViewModel
        .find({ surface, shared: true, ownerId: { $ne: owner } })
        .sort(byName)
        .limit(limits.shared)
        .lean<AdminSavedViewDocumentShape[]>(),
    ]);
    return [...owned, ...shared]
      .map(toRecord)
      .sort((a, b) => (a.name === b.name ? a.id.localeCompare(b.id) : a.name < b.name ? -1 : 1));
  }

  async countOwned(ownerId: string, surface: AdminSavedViewSurface): Promise<number> {
    return this.savedViewModel.countDocuments({ ownerId: new Types.ObjectId(ownerId), surface });
  }

  async create(input: AdminSavedViewCreate): Promise<AdminSavedViewRecord> {
    const document = await this.savedViewModel.create({ ...input, ownerId: new Types.ObjectId(input.ownerId) });
    return toRecord(document.toObject());
  }

  async updateOwned(id: string, ownerId: string, patch: AdminSavedViewPatch): Promise<AdminSavedViewRecord | null> {
    const document = await this.savedViewModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(id), ownerId: new Types.ObjectId(ownerId) },
        { $set: patch },
        { new: true, runValidators: true }
      )
      .lean<AdminSavedViewDocumentShape>();
    return document ? toRecord(document) : null;
  }

  async deleteOwned(id: string, ownerId: string): Promise<boolean> {
    const result = await this.savedViewModel.deleteOne({
      _id: new Types.ObjectId(id),
      ownerId: new Types.ObjectId(ownerId),
    });
    return result.deletedCount === 1;
  }
}

export const adminSavedViewRepository: IAdminSavedViewRepository = new AdminSavedViewRepository(AdminSavedView);
