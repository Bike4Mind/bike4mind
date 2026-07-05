import mongoose, { Model, model, Schema } from 'mongoose';
import { IFeedbackDocument } from '@bike4mind/common';

const feedbackSchema = new Schema<IFeedbackDocument>(
  {
    userId: { type: String, required: true },
    content: { type: String, required: true },
    status: { type: String, required: true },
    tags: { type: Array<string>, required: false },
    username: { type: String, required: true },
    userEmail: { type: String, required: false },
    customerService: { type: String, required: false },
    // TODO: This should be a reference to the organization model
    organization: { type: String, required: false },
    promptMeta: { type: Object, required: false },
    type: { type: String, required: false },
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

export const FeedbackModel: Model<IFeedbackDocument> =
  mongoose.models.Feedback ?? model<IFeedbackDocument>('Feedback', feedbackSchema);

export default FeedbackModel;
