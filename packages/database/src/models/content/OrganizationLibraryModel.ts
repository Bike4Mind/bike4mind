import mongoose, { Schema } from 'mongoose';
import type { OrganizationLibraryItem } from '@bike4mind/common';

export const OrganizationLibrarySchema = new Schema<OrganizationLibraryItem>(
  {
    organizationId: { type: String, required: true, immutable: true },
    kind: { type: String, enum: ['agent', 'skill', 'prompt', 'template'], required: true, immutable: true },
    name: { type: String, required: true, maxlength: 200 },
    description: { type: String, default: '', maxlength: 2000 },
    pinned: { type: Boolean, default: false },
    definition: { type: Schema.Types.Mixed, required: true },
  },
  { timestamps: true, toJSON: { virtuals: true } }
);

OrganizationLibrarySchema.index({ organizationId: 1, pinned: -1, name: 1 });

export const OrganizationLibrary =
  (mongoose.models.OrganizationLibrary as mongoose.Model<OrganizationLibraryItem> | undefined) ??
  mongoose.model<OrganizationLibraryItem>('OrganizationLibrary', OrganizationLibrarySchema);
