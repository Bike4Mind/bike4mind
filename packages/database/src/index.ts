import mongoose from 'mongoose';
import mongooseLeanVirtuals from 'mongoose-lean-virtuals';

// Register mongoose-lean-virtuals globally for all schemas
// This enables .lean({ virtuals: true }) to include the default 'id' virtual getter
mongoose.plugin(mongooseLeanVirtuals);

export * from './models';
export * from './seeds/seedModelPrices';
export * from './queries/fabFileSearchQuery';
export * from './queries/collectionSearchQuery';
export * from '@bike4mind/db-core';
// Shadows db-core's connectDB (explicit exports beat star re-exports): every
// app-layer connect also bootstraps the model price catalog exactly once.
export { connectDB } from './priceCatalogBootstrap';
export * from './utils/ability';
// Propagate db-core's default export (BaseRepository constructor) through the root barrel.
// export * does not re-export defaults; this explicit line is required.
export { default } from '@bike4mind/db-core';

export { mongoose };
