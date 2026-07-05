// Must be first: ensures transactionAsyncLocalStorage is active for any db-core import
import mongoose from 'mongoose';
mongoose.set('transactionAsyncLocalStorage', true);

export { default } from './models/BaseModel'; // default export for facade shims
export { default as BaseRepository } from './models/BaseModel';
export * from './utils/mongo';
export * from './utils/documentdb-compat';
export * from './certs/documentdb-cert-manager';
