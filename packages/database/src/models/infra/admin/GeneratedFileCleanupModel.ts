import mongoose, { Schema } from 'mongoose';
import { z } from 'zod';

/** Only UUID paths created by the generated Files writer, never arbitrary bucket paths. */
export const generatedFileCleanupPathSchema = z
  .string()
  .regex(
    /^(?:generated|generated-audio|generated-video)\/[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}\.[a-z\d]+$/i
  );

type GeneratedFileCleanup = { filePath: string; createdAt: Date; lastAttemptAt?: Date; ambiguousUpload?: boolean };
const schema = new Schema<GeneratedFileCleanup>({
  filePath: {
    type: String,
    required: true,
    unique: true,
    immutable: true,
    validate: (value: string) => generatedFileCleanupPathSchema.safeParse(value).success,
  },
  createdAt: { type: Date, required: true, immutable: true },
  lastAttemptAt: Date,
  ambiguousUpload: Boolean,
});
schema.index({ lastAttemptAt: 1, _id: 1 });

/** No account identifier: this retry anchor must survive creator erasure until the object is removed. */
export const GeneratedFileCleanupModel =
  (mongoose.models.GeneratedFileCleanup as mongoose.Model<GeneratedFileCleanup> | undefined) ??
  mongoose.model<GeneratedFileCleanup>('GeneratedFileCleanup', schema);
