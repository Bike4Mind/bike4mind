import mongoose, { Model, model, Schema } from 'mongoose';
import { IEmailTemplateDocument, IEmailTemplateRepository, EmailCategory } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';
import { PaginatedResponse } from '@bike4mind/common';

export interface IEmailTemplateModel extends Model<IEmailTemplateDocument> {}

const EmailTemplateSchema = new Schema<IEmailTemplateDocument, IEmailTemplateModel>(
  {
    name: { type: String, required: true },
    slug: { type: String, required: true, unique: true },
    description: { type: String },
    subject: { type: String, required: true },
    htmlContent: { type: String, required: true },
    textContent: { type: String },
    category: {
      type: String,
      enum: Object.values(EmailCategory),
      required: true,
    },
    variables: [{ type: String }],
    isActive: { type: Boolean, default: true },
    createdBy: { type: String, required: true },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
    toObject: {
      virtuals: true,
    },
  }
);

// Indexes (slug unique index is defined inline in the schema)
EmailTemplateSchema.index({ category: 1, isActive: 1 });
EmailTemplateSchema.index({ createdAt: -1 });
EmailTemplateSchema.index({ name: 'text', description: 'text' });

export class EmailTemplateRepository
  extends BaseRepository<IEmailTemplateDocument>
  implements IEmailTemplateRepository
{
  constructor(model: IEmailTemplateModel) {
    super(model);
  }

  async findBySlug(slug: string): Promise<IEmailTemplateDocument | null> {
    const result = await this.model.findOne({ slug });
    return result?.toJSON() ?? null;
  }

  async findActiveByCategory(category: EmailCategory): Promise<IEmailTemplateDocument[]> {
    const results = await this.model.find({ category, isActive: true }).sort({ name: 1 });
    return results.map(doc => doc.toJSON());
  }

  async listTemplates(options: {
    page: number;
    limit: number;
    search?: string;
    category?: EmailCategory;
  }): Promise<PaginatedResponse<IEmailTemplateDocument>> {
    const { page, limit, search, category } = options;
    const skip = (page - 1) * limit;

    const query: Record<string, unknown> = {};

    if (search) {
      query.$or = [
        { name: { $regex: escapeRegex(search), $options: 'i' } },
        { description: { $regex: escapeRegex(search), $options: 'i' } },
        { subject: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }

    if (category) {
      query.category = category;
    }

    const [templates, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      this.model.countDocuments(query),
    ]);

    return {
      data: templates.map(doc => doc.toJSON()),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    };
  }
}

export const EmailTemplate =
  (mongoose.models.EmailTemplate as unknown as IEmailTemplateModel) ??
  model<IEmailTemplateDocument, IEmailTemplateModel>('EmailTemplate', EmailTemplateSchema);

export const emailTemplateRepository = new EmailTemplateRepository(EmailTemplate);

export default EmailTemplate;
