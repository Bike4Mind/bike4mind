import mongoose from 'mongoose';
import { softDeletePlugin } from '../../utils/mongo';
import type {
  CustomPageMetaPatch,
  ICustomPageDocument,
  ICustomPageRepository,
  ICustomPageSummary,
  PageWidget,
} from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';

interface ICustomPageModel extends mongoose.Model<ICustomPageDocument> {}

// `.lean()` skips the `id` virtual; every consumer expects `id: string`.
type LeanDoc = { _id: unknown } & Partial<ICustomPageDocument>;
function withId<T extends ICustomPageSummary>(doc: LeanDoc): T {
  return { ...doc, id: String(doc._id) } as unknown as T;
}

const SUMMARY_PROJECTION = '-state -widgets';

class CustomPageRepository extends BaseRepository<ICustomPageDocument> implements ICustomPageRepository {
  constructor(private pageModel: ICustomPageModel) {
    super(pageModel);
  }

  // BaseRepository.create returns toObject() without the `id` virtual.
  async create(data: Parameters<BaseRepository<ICustomPageDocument>['create']>[0]) {
    const created = await this.pageModel.create(data);
    return withId<ICustomPageDocument>(created.toObject() as unknown as LeanDoc) as Awaited<
      ReturnType<BaseRepository<ICustomPageDocument>['create']>
    >;
  }

  private owned(id: string, userId: string) {
    return { _id: id, userId, deletedAt: null };
  }

  async listOwned(userId: string): Promise<ICustomPageSummary[]> {
    const results = await this.pageModel
      .find({ userId, deletedAt: null })
      .select(SUMMARY_PROJECTION)
      .sort({ updatedAt: -1 })
      .lean<LeanDoc[]>();
    return results.map(doc => withId<ICustomPageSummary>(doc));
  }

  async findOwned(id: string, userId: string): Promise<ICustomPageDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.pageModel.findOne(this.owned(id, userId)).lean<LeanDoc>();
    return result ? withId<ICustomPageDocument>(result) : null;
  }

  async findByOrchestratorSession(sessionId: string, userId: string): Promise<ICustomPageDocument | null> {
    const result = await this.pageModel
      .findOne({ orchestratorSessionId: sessionId, userId, deletedAt: null })
      .lean<LeanDoc>();
    return result ? withId<ICustomPageDocument>(result) : null;
  }

  async updateMetaOwned(id: string, userId: string, patch: CustomPageMetaPatch): Promise<ICustomPageDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.pageModel
      .findOneAndUpdate(this.owned(id, userId), { $set: patch }, { new: true })
      .lean<LeanDoc>();
    return result ? withId<ICustomPageDocument>(result) : null;
  }

  async replaceStateOwned(
    id: string,
    userId: string,
    state: Record<string, unknown>,
    expectedVersion: number
  ): Promise<ICustomPageDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.pageModel
      .findOneAndUpdate(
        { ...this.owned(id, userId), version: expectedVersion },
        { $set: { state }, $inc: { version: 1 } },
        { new: true }
      )
      .lean<LeanDoc>();
    return result ? withId<ICustomPageDocument>(result) : null;
  }

  async upsertWidgetOwned(
    id: string,
    userId: string,
    widget: PageWidget,
    maxWidgets: number
  ): Promise<ICustomPageDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const replaced = await this.pageModel
      .findOneAndUpdate(
        { ...this.owned(id, userId), 'widgets.id': widget.id },
        { $set: { 'widgets.$': widget } },
        { new: true }
      )
      .lean<LeanDoc>();
    if (replaced) return withId<ICustomPageDocument>(replaced);

    // The $ne guard keeps a concurrent upsert of the same id from appending a duplicate; the
    // index probe enforces the cap atomically.
    const appended = await this.pageModel
      .findOneAndUpdate(
        {
          ...this.owned(id, userId),
          'widgets.id': { $ne: widget.id },
          [`widgets.${maxWidgets - 1}`]: { $exists: false },
        },
        { $push: { widgets: widget } },
        { new: true }
      )
      .lean<LeanDoc>();
    return appended ? withId<ICustomPageDocument>(appended) : null;
  }

  async removeWidgetOwned(id: string, userId: string, widgetId: string): Promise<ICustomPageDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.pageModel
      .findOneAndUpdate(this.owned(id, userId), { $pull: { widgets: { id: widgetId } } }, { new: true })
      .lean<LeanDoc>();
    return result ? withId<ICustomPageDocument>(result) : null;
  }

  async setChecklistItemOwned(
    id: string,
    userId: string,
    widgetId: string,
    itemId: string,
    checked: boolean
  ): Promise<ICustomPageDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const result = await this.pageModel
      .findOneAndUpdate(
        {
          ...this.owned(id, userId),
          widgets: { $elemMatch: { id: widgetId, type: 'checklist', 'items.id': itemId } },
        },
        { $set: { 'widgets.$[w].items.$[i].checked': checked } },
        { new: true, arrayFilters: [{ 'w.id': widgetId, 'w.type': 'checklist' }, { 'i.id': itemId }] }
      )
      .lean<LeanDoc>();
    return result ? withId<ICustomPageDocument>(result) : null;
  }

  async softDeleteOwned(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.pageModel.updateOne(this.owned(id, userId), { $set: { deletedAt: new Date() } });
    return result.modifiedCount > 0;
  }
}

const CustomPageSchema = new mongoose.Schema<ICustomPageDocument>(
  {
    userId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 120 },
    icon: { type: String, default: null, maxlength: 40 },
    description: { type: String, default: null, maxlength: 1000 },
    // Shape and size are enforced by customPageService (PAGE_STATE_MAX_BYTES, PageWidgetSchema).
    state: { type: mongoose.Schema.Types.Mixed, default: {} },
    // Mixed rather than [Mixed]: Mongoose's schema typing cannot express an array of a discriminated union.
    widgets: { type: mongoose.Schema.Types.Mixed, default: [] },
    orchestratorSessionId: { type: String, required: true },
    version: { type: Number, default: 0 },
  },
  // minimize: false so a new page stores `state: {}` instead of dropping the key.
  { timestamps: true, minimize: false }
);

CustomPageSchema.plugin(softDeletePlugin);

CustomPageSchema.index({ userId: 1, deletedAt: 1, updatedAt: -1 });
CustomPageSchema.index({ orchestratorSessionId: 1 });

export const CustomPage: ICustomPageModel =
  (mongoose.models.CustomPage as ICustomPageModel) ||
  mongoose.model<ICustomPageDocument, ICustomPageModel>('CustomPage', CustomPageSchema);

export const customPageRepository = new CustomPageRepository(CustomPage);
