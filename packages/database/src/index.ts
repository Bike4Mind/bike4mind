import mongoose from 'mongoose';
import mongooseLeanVirtuals from 'mongoose-lean-virtuals';

// Register mongoose-lean-virtuals globally for all schemas
// This enables .lean({ virtuals: true }) to include the default 'id' virtual getter
mongoose.plugin(mongooseLeanVirtuals);

export * from './models';
export * from './queries/fabFileSearchQuery';
export * from './queries/collectionSearchQuery';
export * from '@bike4mind/db-core';
export * from './utils/ability';
// Propagate db-core's default export (BaseRepository constructor) through the root barrel.
// export * does not re-export defaults; this explicit line is required.
export { default } from '@bike4mind/db-core';

export { mongoose };
