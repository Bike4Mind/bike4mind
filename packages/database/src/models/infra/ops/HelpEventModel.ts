import mongoose, { Document, Model, model, Schema } from 'mongoose';
import { HELP_FEEDBACK_RATINGS, HelpFeedbackRating } from '@bike4mind/common';

export interface IHelpEventDocument extends Document {
  type: 'article_view' | 'search' | 'article_feedback' | 'chat_query' | 'chat_feedback';
  userId: string;
  slug?: string;
  articleTitle?: string;
  searchQuery?: string;
  searchResultCount?: number;
  rating?: HelpFeedbackRating;
  reportType?: 'outdated';
  /** @deprecated No longer written - human-written comments route to `Feedback` (subject 'help')
   * via `helpFeedbackRouting.ts`. Kept so rows written before the split still read back until the
   * 90-day TTL below sweeps them; `withRoutedComment` in that module is the read-side fallback. */
  comment?: string;
  chatQuestion?: string;
  chatAnswer?: string;
  createdAt: Date;
  updatedAt: Date;
}

const helpEventSchema = new Schema<IHelpEventDocument>(
  {
    type: {
      type: String,
      required: true,
      enum: ['article_view', 'search', 'article_feedback', 'chat_query', 'chat_feedback'],
    },
    userId: { type: String, required: true },
    slug: { type: String, required: false },
    articleTitle: { type: String, required: false },
    searchQuery: { type: String, required: false },
    searchResultCount: { type: Number, required: false },
    rating: { type: String, required: false, enum: HELP_FEEDBACK_RATINGS },
    reportType: { type: String, required: false, enum: ['outdated'] },
    // Deprecated - see IHelpEventDocument above. Read-only legacy field.
    comment: { type: String, required: false, maxlength: 1000 },
    chatQuestion: { type: String, required: false, maxlength: 2000 },
    chatAnswer: { type: String, required: false, maxlength: 10000 },
  },
  {
    timestamps: true,
  }
);

helpEventSchema.index({ type: 1, createdAt: 1 });
helpEventSchema.index({ slug: 1, type: 1 });
helpEventSchema.index({ userId: 1, slug: 1, type: 1 });
// Auto-expire events after 90 days to prevent unbounded collection growth
helpEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

export const HelpEventModel: Model<IHelpEventDocument> =
  mongoose.models.HelpEvent ?? model<IHelpEventDocument>('HelpEvent', helpEventSchema);

export default HelpEventModel;
