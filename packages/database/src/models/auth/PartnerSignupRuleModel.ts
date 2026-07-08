import mongoose, { Model, model, Schema } from 'mongoose';
import { IPartnerSignupRuleDocument, IPartnerSignupRuleRepository } from '@bike4mind/common';
import { normalizeSignupRuleDomain } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { escapeRegex } from '@bike4mind/utils/escapeRegex';

export interface IPartnerSignupRuleModel extends Model<IPartnerSignupRuleDocument> {}

export class PartnerSignupRuleRepository
  extends BaseRepository<IPartnerSignupRuleDocument>
  implements IPartnerSignupRuleRepository
{
  constructor(model: IPartnerSignupRuleModel) {
    super(model);
  }

  async findByDomain(domain: string) {
    const result = await this.model.findOne({
      domain: normalizeSignupRuleDomain(domain),
      deletedAt: null,
    });
    return result?.toJSON() ?? null;
  }

  async findActiveRules() {
    const results = await this.model.find({ enabled: true, deletedAt: null });
    return results.map(doc => doc.toJSON());
  }

  async listRules(options: { page: number; limit: number; search?: string }) {
    const { page, limit, search } = options;
    const skip = (page - 1) * limit;

    const query = {
      deletedAt: null,
      ...(search && {
        $or: [
          { domain: { $regex: escapeRegex(search), $options: 'i' } },
          { label: { $regex: escapeRegex(search), $options: 'i' } },
        ],
      }),
    };

    const [rules, total] = await Promise.all([
      this.model.find(query).sort({ createdAt: -1 }).skip(skip).limit(limit),
      this.model.countDocuments(query),
    ]);

    return {
      data: rules.map(doc => doc.toJSON()),
      meta: {
        currentPage: page,
        totalPages: Math.ceil(total / limit),
        total,
      },
    };
  }
}

export const PartnerSignupRuleSchema = new Schema<IPartnerSignupRuleDocument, IPartnerSignupRuleModel>(
  {
    // `set` normalizes at the model boundary so a direct write (migration, script)
    // is stored the same way the Zod-validated API path stores it - the domain is
    // the lookup key, so a case/whitespace drift would silently miss.
    domain: { type: String, required: true, unique: true, set: normalizeSignupRuleDomain },
    entitlements: { type: [String], default: [] },
    signupCredits: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true },
    label: { type: String, default: null },
    notes: { type: String, default: null },
    createdBy: { type: String, default: null },
    deletedAt: { type: Date, default: null },
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

// Performance indexes (unique domain is declared on the field as a data constraint).
PartnerSignupRuleSchema.index({ deletedAt: 1 });
PartnerSignupRuleSchema.index({ enabled: 1, deletedAt: 1 });

export const PartnerSignupRule =
  (mongoose.models.PartnerSignupRule as unknown as IPartnerSignupRuleModel) ??
  model<IPartnerSignupRuleDocument, IPartnerSignupRuleModel>('PartnerSignupRule', PartnerSignupRuleSchema);

export const partnerSignupRuleRepository = new PartnerSignupRuleRepository(PartnerSignupRule);

export default PartnerSignupRule;
