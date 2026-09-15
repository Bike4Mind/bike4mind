import mongoose, { Model, model, Schema } from 'mongoose';
import { IEmailPreferencesDocument, IEmailPreferencesRepository, EmailCategory } from '@bike4mind/common';
import BaseRepository from '@bike4mind/db-core';
import { randomUUID } from 'crypto';

export interface IEmailPreferencesModel extends Model<IEmailPreferencesDocument> {}

const EmailPreferencesSchema = new Schema<IEmailPreferencesDocument, IEmailPreferencesModel>(
  {
    userId: { type: String, sparse: true },
    subscriberId: { type: String, sparse: true },
    email: { type: String, required: true, unique: true },
    unsubscribedCategories: [
      {
        type: String,
        enum: Object.values(EmailCategory),
      },
    ],
    globalUnsubscribe: { type: Boolean, default: false },
    unsubscribeToken: { type: String, required: true, unique: true },
    unsubscribedAt: { type: Date },
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

// Indexes (email and unsubscribeToken unique indexes are defined inline in the schema)
// userId and subscriberId sparse indexes are also defined inline

export class EmailPreferencesRepository
  extends BaseRepository<IEmailPreferencesDocument>
  implements IEmailPreferencesRepository
{
  constructor(model: IEmailPreferencesModel) {
    super(model);
  }

  async findByEmail(email: string): Promise<IEmailPreferencesDocument | null> {
    const result = await this.model.findOne({ email: email.toLowerCase() });
    return result?.toJSON() ?? null;
  }

  async findByUnsubscribeToken(token: string): Promise<IEmailPreferencesDocument | null> {
    const result = await this.model.findOne({ unsubscribeToken: token });
    return result?.toJSON() ?? null;
  }

  async findOrCreate(email: string, userId?: string, subscriberId?: string): Promise<IEmailPreferencesDocument> {
    const normalizedEmail = email.toLowerCase();
    let prefs = await this.model.findOne({ email: normalizedEmail });

    if (!prefs) {
      prefs = await this.model.create({
        email: normalizedEmail,
        userId,
        subscriberId,
        unsubscribedCategories: [],
        globalUnsubscribe: false,
        unsubscribeToken: randomUUID(),
      });
    } else if ((userId && !prefs.userId) || (subscriberId && !prefs.subscriberId)) {
      // Update with user/subscriber ID if not already set
      const updates: Record<string, string> = {};
      if (userId && !prefs.userId) updates.userId = userId;
      if (subscriberId && !prefs.subscriberId) updates.subscriberId = subscriberId;
      prefs = await this.model.findByIdAndUpdate(prefs._id, updates, { new: true });
    }

    return prefs!.toJSON();
  }

  async unsubscribeFromCategory(email: string, category: EmailCategory): Promise<void> {
    await this.model.findOneAndUpdate(
      { email: email.toLowerCase() },
      {
        $addToSet: { unsubscribedCategories: category },
        $set: { unsubscribedAt: new Date() },
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
  }

  async globalUnsubscribe(email: string): Promise<void> {
    const normalizedEmail = email.toLowerCase();
    await this.model.findOneAndUpdate(
      { email: normalizedEmail },
      {
        $set: {
          globalUnsubscribe: true,
          unsubscribedAt: new Date(),
        },
      },
      {
        upsert: true,
        setDefaultsOnInsert: true,
      }
    );

    // Ensure token exists for upserted documents
    await this.model.findOneAndUpdate(
      { email: normalizedEmail, unsubscribeToken: { $exists: false } },
      { $set: { unsubscribeToken: randomUUID() } }
    );
  }

  async resubscribe(email: string, category?: EmailCategory): Promise<void> {
    const normalizedEmail = email.toLowerCase();

    if (category) {
      // Remove specific category from unsubscribed list
      await this.model.findOneAndUpdate({ email: normalizedEmail }, { $pull: { unsubscribedCategories: category } });
    } else {
      // Full resubscribe - clear global and all categories
      await this.model.findOneAndUpdate(
        { email: normalizedEmail },
        {
          $set: {
            globalUnsubscribe: false,
            unsubscribedCategories: [],
            unsubscribedAt: undefined,
          },
        }
      );
    }
  }
}

export const EmailPreferences =
  (mongoose.models.EmailPreferences as unknown as IEmailPreferencesModel) ??
  model<IEmailPreferencesDocument, IEmailPreferencesModel>('EmailPreferences', EmailPreferencesSchema);

export const emailPreferencesRepository = new EmailPreferencesRepository(EmailPreferences);

export default EmailPreferences;
