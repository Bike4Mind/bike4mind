import mongoose from 'mongoose';
import {
  STUDIO_COMPOSITION_LIMITS,
  STUDIO_COMPOSITION_TEMPLATES,
  type IStudioComposition,
  type IStudioCompositionDocument,
  type IStudioCompositionRepository,
  type IStudioCompositionSummary,
  type StudioCompositionContent,
} from '@bike4mind/common';

/**
 * Studio Productions. Field-for-field parity with StudioCompositionSchema in @bike4mind/common
 * (studioComposition/composition.ts), enforced by StudioCompositionModel.test.ts. Zod validates every write, so
 * the shot list and the versioned timeline spec are stored as Mixed rather than mirrored here a second time.
 */
type IStudioCompositionModel = mongoose.Model<IStudioCompositionDocument>;

type LeanDoc = { _id: unknown; __v?: unknown } & Omit<IStudioCompositionDocument, 'id'>;
const withId = ({ _id, __v, ...doc }: LeanDoc): IStudioCompositionDocument => ({ ...doc, id: String(_id) });

const SUMMARY_PROJECTION = { shots: 0, timeline: 0 } as const;

class StudioCompositionRepository implements IStudioCompositionRepository {
  constructor(private readonly model: IStudioCompositionModel) {}

  async createOwned(composition: IStudioComposition): Promise<IStudioCompositionDocument> {
    const created = await this.model.create(composition);
    return withId(created.toObject<LeanDoc>());
  }

  async findOwned(id: string, userId: string): Promise<IStudioCompositionDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const found = await this.model.findOne({ _id: id, userId }).lean<LeanDoc>();
    return found ? withId(found) : null;
  }

  async listOwned(userId: string, page: { limit: number; skip: number }): Promise<IStudioCompositionSummary[]> {
    const found = await this.model
      .find({ userId }, SUMMARY_PROJECTION)
      .sort({ updatedAt: -1, _id: -1 })
      .skip(page.skip)
      .limit(page.limit)
      .lean<LeanDoc[]>();
    return found.map(withId);
  }

  async updateOwned(
    id: string,
    userId: string,
    patch: Partial<StudioCompositionContent>,
    unset: ReadonlyArray<keyof StudioCompositionContent> = []
  ): Promise<IStudioCompositionDocument | null> {
    if (!mongoose.isValidObjectId(id)) return null;
    const update = {
      $set: patch,
      ...(unset.length > 0 && { $unset: Object.fromEntries(unset.map(field => [field, 1])) }),
    };
    const updated = await this.model
      .findOneAndUpdate({ _id: id, userId }, update, { new: true, runValidators: true })
      .lean<LeanDoc>();
    return updated ? withId(updated) : null;
  }

  async deleteOwned(id: string, userId: string): Promise<boolean> {
    if (!mongoose.isValidObjectId(id)) return false;
    const result = await this.model.deleteOne({ _id: id, userId });
    return result.deletedCount > 0;
  }
}

const limits = STUDIO_COMPOSITION_LIMITS;

const BriefSchema = new mongoose.Schema(
  {
    summary: { type: String, maxlength: limits.briefSummaryMaxLength },
    audience: { type: String, maxlength: limits.briefFieldMaxLength },
    callToAction: { type: String, maxlength: limits.briefFieldMaxLength },
    tone: { type: String, maxlength: limits.briefFieldMaxLength },
    productFileId: { type: String },
  },
  { _id: false }
);

// id: false, because `id` is a stored field here and Mongoose would otherwise shadow it with its virtual.
const CharacterSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },
    name: { type: String, required: true, maxlength: limits.characterNameMaxLength },
    fileId: { type: String, required: true },
  },
  { _id: false, id: false }
);

const BrandKitSchema = new mongoose.Schema(
  {
    logoFileId: { type: String },
    colors: { type: [String], default: [] },
    fontFamily: { type: String },
    productFileIds: { type: [String], default: [] },
    characters: { type: [CharacterSchema], default: [] },
  },
  { _id: false }
);

const StudioCompositionMongooseSchema = new mongoose.Schema<IStudioCompositionDocument>(
  {
    userId: { type: String, required: true },
    // Reserved for organization ownership (a pending decision); access is owner-only until then.
    organizationId: { type: String },
    projectId: { type: String },
    title: { type: String, required: true, maxlength: limits.titleMaxLength },
    template: { type: String, enum: STUDIO_COMPOSITION_TEMPLATES, required: true },
    brief: { type: BriefSchema, default: () => ({}) },
    brandKit: { type: BrandKitSchema, default: () => ({}) },
    shots: { type: mongoose.Schema.Types.Mixed, default: () => [] },
    timeline: { type: mongoose.Schema.Types.Mixed, required: true },
  },
  // minimize: false keeps an empty brief as {} so reads match the Zod output shape.
  { timestamps: true, versionKey: false, minimize: false }
);

// Performance indexes (declared together per repo guidelines). Every query is owner-scoped; the list sorts newest
// updated first.
StudioCompositionMongooseSchema.index({ userId: 1, updatedAt: -1, _id: -1 });

export const StudioComposition: IStudioCompositionModel =
  (mongoose.models.StudioComposition as IStudioCompositionModel) ||
  mongoose.model<IStudioCompositionDocument>('StudioComposition', StudioCompositionMongooseSchema);

export const studioCompositionRepository = new StudioCompositionRepository(StudioComposition);
