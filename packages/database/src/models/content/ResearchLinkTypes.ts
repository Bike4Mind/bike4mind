import {
  IResearchLink,
  IResearchLinkDocument,
  IResearchLinkCategory,
  IResearchLinkCategoryDocument,
} from '@bike4mind/common';
import mongoose, { Schema } from 'mongoose';

const ResearchLinkCategoryModelSchema = new Schema<IResearchLinkCategoryDocument>(
  {
    name: { type: String, required: true },
    description: { type: String, required: true },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

const ResearchLinkModelSchema = new Schema<IResearchLinkDocument>(
  {
    name: { type: String, required: true },
    url: { type: String, required: true },
    ticker: { type: String },
    type: { type: String },
    categoryId: { type: Schema.Types.ObjectId, ref: 'ResearchLinkCategory' },
  },
  {
    timestamps: true,
    virtuals: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

export const ResearchLinkCategory: mongoose.Model<IResearchLinkCategory> =
  mongoose.models.ResearchLinkCategory ||
  mongoose.model<IResearchLinkCategoryDocument>('ResearchLinkCategory', ResearchLinkCategoryModelSchema);

export const ResearchLink: mongoose.Model<IResearchLink> =
  mongoose.models.ResearchLink || mongoose.model<IResearchLinkDocument>('ResearchLink', ResearchLinkModelSchema);

export default ResearchLink;
