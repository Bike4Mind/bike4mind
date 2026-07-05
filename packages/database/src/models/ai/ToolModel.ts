import mongoose, { Model, model, Schema } from 'mongoose';
import BaseRepository from '@bike4mind/db-core';
import { ShareableDocumentSchema, ShareableDocumentRepository } from '../content/SharableDocumentModel';
import { IToolDocument, LLMParams } from '@bike4mind/common';
import { softDeletePlugin } from '../../utils/mongo';

// This is the canonical name of the model, used in determining the collection name in Mongo.
// If this changes, you'll need to adjust a few parallel mentions in the code (build will fail
// and tell you which ones).  You'll also need to move any documents in the old collection to
// the new one.
const ModelName = 'ToolModel';

const llmParamsSchema: Schema = new Schema<LLMParams>({
  model: { type: String, default: 'gpt-3.5-turbo' },
  temperature: { type: Number, default: 0.9 },
  top_p: { type: Number, default: 1 },
  n: { type: Number, default: 1 },
  stream: { type: Boolean, default: true },
  stop: Schema.Types.Mixed,
  max_tokens: Number,
  presence_penalty: { type: Number, default: 0 },
  frequency_penalty: { type: Number, default: 0 },
  logit_bias: Schema.Types.Mixed,
});

const ToolSchema: Schema = new Schema(
  {
    name: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    workBenchFiles: [{ type: Schema.Types.Mixed, required: true }], // You might want to create a sub-schema for workBenchFiles
    llmParams: { type: llmParamsSchema, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
    ...ShareableDocumentSchema,
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  }
);

ToolSchema.plugin(softDeletePlugin);

export const Tool: Model<IToolDocument> = mongoose.models[ModelName] ?? model<IToolDocument>(ModelName, ToolSchema);

export class ToolRepository extends BaseRepository<IToolDocument> {
  shareable: ShareableDocumentRepository<IToolDocument>;

  constructor() {
    super(Tool);
    this.shareable = new ShareableDocumentRepository(Tool);
  }
}

export const toolRepository = new ToolRepository();

export default Tool;
