import { Logger } from '@bike4mind/observability';
import mongoose, { ConnectOptions } from 'mongoose';
import {
  getDocumentDBCertificate,
  isDocumentDBConnection,
  addCertificateToUri,
} from '../certs/documentdb-cert-manager';

/**
 * Sleep utility for retry delays
 */
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Calculate exponential backoff delay with jitter
 * Base delay doubles each retry, with random jitter to prevent thundering herd
 */
const getBackoffDelay = (attempt: number, baseDelayMs = 1000, maxDelayMs = 30000): number => {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, capped at maxDelayMs
  const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
  // Add random jitter (0-50% of the delay) to prevent thundering herd
  const jitter = Math.random() * 0.5 * exponentialDelay;
  return Math.floor(exponentialDelay + jitter);
};

/**
 * Check if an error is retryable (transient connection issues)
 */
const isRetryableError = (error: Error): boolean => {
  const retryableMessages = [
    'Client network socket disconnected',
    'before secure TLS connection', // Matches "disconnected before secure TLS connection was established"
    'TLS handshake failed',
    'Connection pool',
    'was cleared',
    'Could not connect to any servers',
    'connection timed out',
    'ECONNREFUSED',
    'ETIMEDOUT',
    'ENOTFOUND',
    'socket hang up',
    'getaddrinfo',
    'Server selection timed out',
  ];

  const errorMessage = error.message?.toLowerCase() || '';
  return retryableMessages.some(msg => errorMessage.includes(msg.toLowerCase()));
};

/**
 * Check if a MongoDB error is a transient transaction error that should be retried.
 * MongoDB recommends retrying operations with the TransientTransactionError label.
 *
 * @see https://www.mongodb.com/docs/manual/core/transactions-in-applications/#std-label-txn-retry
 */
export function isTransientTransactionError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;

  const mongoError = error as { code?: number; errorLabels?: string[] };

  // Check for TransientTransactionError label (MongoDB's official recommendation)
  if (mongoError.errorLabels?.includes('TransientTransactionError')) {
    return true;
  }

  // Fallback: check specific error codes that are transient
  const transientCodes = [
    112, // WriteConflict
    251, // NoSuchTransaction (transaction aborted/timed out)
  ];

  return transientCodes.includes(mongoError.code ?? -1);
}

export const connectDB = async (url: string, logger?: Logger) => {
  logger ??= Logger.withMetadata({});
  if (mongoose.connection.readyState === 1) {
    return true;
  }

  // Check if this is a DocumentDB connection and handle certificate
  let connectionUrl = url;
  if (isDocumentDBConnection(url)) {
    logger.info('Detected DocumentDB connection, setting up TLS certificate');
    const { certPath, certExists } = getDocumentDBCertificate();
    if (!certExists) {
      logger.info(`Created DocumentDB certificate at ${certPath}`);
    }
    connectionUrl = addCertificateToUri(url, certPath);
  }

  // Allow pool size to be configured via environment variable for better local dev performance
  const maxPoolSize = process.env.MONGODB_MAX_POOL_SIZE ? parseInt(process.env.MONGODB_MAX_POOL_SIZE, 10) : 2;

  const options: ConnectOptions = {
    // Causes indexes to be built automatically. This is the default, but
    // here we make it explicit:
    autoIndex: true,
    minPoolSize: 1,
    // One connection per request is likely enough; 2 may be more than needed.
    maxPoolSize,
    // Close idle connections after 30s in Lambda/DocumentDB so stale connections
    // don't cause EPIPE errors. Only set for DocumentDB; local/long-running
    // processes keep the default (no idle timeout) to avoid unnecessary churn.
    ...(isDocumentDBConnection(url) && {
      maxIdleTimeMS: parseInt(process.env.MONGODB_MAX_IDLE_TIME_MS || '30000', 10),
    }),
    // Connection timeout settings to handle Lambda cold starts and network issues
    serverSelectionTimeoutMS: 30000, // 30s to select a server (default is 30s)
    connectTimeoutMS: 30000, // 30s to establish initial connection
    socketTimeoutMS: 45000, // 45s for socket operations
    // Retry settings for transient failures
    // DocumentDB doesn't support retryable writes, so disable for DocumentDB connections
    retryWrites: !isDocumentDBConnection(url),
    retryReads: true,
  };

  // Retry configuration
  const maxRetries = parseInt(process.env.MONGODB_MAX_RETRIES || '3', 10);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      if (attempt > 0) {
        const delay = getBackoffDelay(attempt - 1);
        logger.info(`MongoDB connection retry ${attempt}/${maxRetries} after ${delay}ms delay`);
        await sleep(delay);
      }

      await mongoose.connect(connectionUrl, options);
      if (attempt > 0) {
        logger.info(`MongoDB connection succeeded on retry ${attempt}`);
      }

      return true;
    } catch (err: unknown) {
      const error = err as Error;
      lastError = error;

      if (attempt < maxRetries && isRetryableError(error)) {
        logger.warn(`MongoDB connection attempt ${attempt + 1}/${maxRetries + 1} failed: ${error.message}`);
      } else if (attempt < maxRetries) {
        // Non-retryable error, but we'll still retry in case it's transient
        logger.warn(
          `MongoDB connection attempt ${attempt + 1}/${maxRetries + 1} failed (non-retryable pattern): ${error.message}`
        );
      } else {
        // Final attempt failed
        logger.error(`MongoDB connection failed after ${maxRetries + 1} attempts: ${error.message}`);
      }
    }
  }

  // All retries exhausted
  throw new Error(
    `Database connection failed after ${maxRetries + 1} attempts: ${lastError?.message || 'Unknown error'}`
  );
};

export const getDB = () => {
  return mongoose;
};

/**
 * Execute a function within a MongoDB transaction with automatic retry on transient errors.
 *
 * Note: We have [transactionAsyncLocalStorage](https://mongoosejs.com/docs/transactions.html#asynclocalstorage)
 * enabled by default, so we don't need to pass in a session.
 *
 * **Important:** The callback function MUST be idempotent because it may be re-executed on retry.
 * Database writes are rolled back on failure, but external side effects (e.g., API calls) are not.
 *
 * Retry behavior:
 * - Only retries on TransientTransactionError (e.g., WriteConflict)
 * - Uses exponential backoff with 25% jitter to prevent thundering herd
 * - Conservative retry count (2) since MongoDB driver already retries internally
 *
 * @param fn - The transaction callback (must be idempotent)
 * @param options - Transaction options including optional logger and maxRetries
 * @returns The result of the transaction callback
 *
 * @see https://www.mongodb.com/docs/manual/core/transactions-in-applications/#std-label-txn-retry
 */
export const withTransaction = async <T>(
  fn: (session: mongoose.mongo.ClientSession) => Promise<T>,
  options?: Partial<mongoose.mongo.TransactionOptions> & {
    logger?: Logger;
    /** Maximum retry attempts for transient errors (default: 2) */
    maxRetries?: number;
  }
): Promise<T> => {
  const maxRetries = options?.maxRetries ?? 2;
  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await mongoose.connection.transaction(async session => {
        options?.logger?.debug('Starting transaction...', { attempt: attempt + 1 });
        const result = await fn(session);
        options?.logger?.debug('Transaction completed');
        return result;
      }, options);
    } catch (error) {
      lastError = error;

      // Only retry transient transaction errors
      if (!isTransientTransactionError(error)) {
        throw error;
      }

      // Don't retry if we've exhausted attempts
      if (attempt >= maxRetries) {
        options?.logger?.warn(`Transaction failed after ${maxRetries + 1} attempts`, {
          error: error instanceof Error ? error.message : String(error),
          code: (error as { code?: number })?.code,
          errorLabels: (error as { errorLabels?: string[] })?.errorLabels,
        });
        throw error;
      }

      // Exponential backoff with jitter (25%) to prevent thundering herd
      const baseDelay = 100 * Math.pow(2, attempt); // 100ms, 200ms
      const jitter = baseDelay * 0.25 * Math.random();
      const delayMs = Math.round(baseDelay + jitter);

      options?.logger?.info(`TransientTransactionError, retrying in ${delayMs}ms`, {
        attempt: attempt + 1,
        maxRetries,
        code: (error as { code?: number })?.code,
        delayMs,
      });

      await sleep(delayMs);
    }
  }

  throw lastError;
};

export interface InputRecordValue {
  [key: string]:
    | string
    | number
    | null
    | {
        $oid?: string;
        $date?: { $numberLong: string };
        $numberInt?: string;
        $numberLong?: string;
      }
    | InputRecordValue
    | InputRecordValue[];
}

export interface OutputRecordValue {
  [key: string]: string | number | null | Date | mongoose.Types.ObjectId | OutputRecordValue | OutputRecordValue[];
}

export const mongoExportedRecordConverter = (record: InputRecordValue): OutputRecordValue | OutputRecordValue[] => {
  if (Array.isArray(record)) return record.map(mongoExportedRecordConverter) as OutputRecordValue[];
  if (typeof record !== 'object') return record;

  return Object.entries(record).reduce((acc, [key, value]) => {
    if (!value) {
      acc[key] = value;
    } else if (Array.isArray(value)) {
      acc[key] = value.map(mongoExportedRecordConverter) as OutputRecordValue[];
    } else if (typeof value !== 'object') {
      acc[key] = value;
    } else if (value.$oid) {
      acc[key] = new mongoose.Types.ObjectId(value.$oid as string);
    } else if (value.$date) {
      acc[key] = new Date(
        typeof value.$date === 'string' ? value.$date : parseInt((value.$date as { $numberLong: string }).$numberLong)
      );
    } else if (value.$numberInt) {
      acc[key] = parseInt(value.$numberInt as string);
    } else if (value.$numberLong) {
      acc[key] = parseInt(value.$numberLong as string);
    } else {
      acc[key] = mongoExportedRecordConverter(value);
    }
    return acc;
  }, {} as OutputRecordValue);
};

export function findModelByCollectionName(collectionName: string) {
  const modelNames = mongoose.modelNames();

  for (const modelName of modelNames) {
    const model = mongoose.model(modelName);
    if (model.collection.collectionName === collectionName) {
      return model;
    }
  }

  return null;
}

// TODO: populate when soft-delete options (e.g. deletedAtField name) are needed
export interface SoftDeletePluginOptions {}

// Casts all string/ObjectId values inside a MongoDB operator object so every
// operator ($eq, $ne, $gt, $in, $nin, ...) reaches the raw driver as ObjectId.
function castIdOperators(q: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [op, val] of Object.entries(q)) {
    if (Array.isArray(val)) {
      result[op] = val.map(v => (typeof v === 'string' || v instanceof mongoose.Types.ObjectId ? convertId(v) : v));
    } else if (typeof val === 'string' || val instanceof mongoose.Types.ObjectId) {
      result[op] = convertId(val);
    } else {
      result[op] = val;
    }
  }
  return result;
}

// Casts _id values in a filter to ObjectId so the raw MongoDB driver (used by
// softDeletePlugin to avoid Mongoose 8's path-inference bug) receives the correct type.
// Handles bare scalars, all operator shapes ($eq/$ne/$gt/$in/... - via castIdOperators),
// and recurses into top-level $or/$and so CASL-generated nested _id conditions are cast.
// Idempotent: existing ObjectId values pass through unchanged via convertId.
function castIdFilter(filter: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...filter };

  // Recurse into $or/$and branches - CASL's accessibleBy emits $or arrays that may
  // contain { _id: stringId } conditions when ability rules target individual documents.
  if (Array.isArray(result.$or)) {
    result.$or = result.$or.map(branch =>
      branch !== null && typeof branch === 'object' ? castIdFilter(branch as Record<string, unknown>) : branch
    );
  }
  if (Array.isArray(result.$and)) {
    result.$and = result.$and.map(branch =>
      branch !== null && typeof branch === 'object' ? castIdFilter(branch as Record<string, unknown>) : branch
    );
  }

  if (!('_id' in result)) return result;

  const idVal = result._id;
  if (idVal instanceof mongoose.Types.ObjectId || typeof idVal === 'string') {
    result._id = convertId(idVal);
  } else if (idVal !== null && typeof idVal === 'object' && !Array.isArray(idVal)) {
    result._id = castIdOperators(idVal as Record<string, unknown>);
  }
  // null and other non-castable values pass through - null is a valid "match nothing"
  // sentinel; anything else is invalid and will be rejected by the MongoDB driver.

  return result;
}

export const softDeletePlugin = (
  // mongoose 8.24 defaults Document's _id to ObjectId; under the `any` schema
  // generic below, this.save() resolves _id to `unknown`, so the method return
  // must be Document<unknown> to unify (not the default Document<ObjectId>).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- MongoDB schema types are inherently dynamic
  schema: mongoose.Schema<any, any, { softDelete: () => Promise<mongoose.Document<unknown>> }>,
  // options reserved for future configuration (see SoftDeletePluginOptions)
  _options?: SoftDeletePluginOptions
) => {
  // Add a 'deletedAt' field to the schema if it doesn't already exist
  schema.add({
    deletedAt: {
      type: Date,
      default: null,
    },
  });

  // Define a 'softDelete' method to mark documents as soft-deleted
  schema.methods.softDelete = async function () {
    this.deletedAt = new Date();
    return this.save();
  };

  // Define a 'restore' method to restore soft-deleted documents
  schema.methods.restore = function () {
    this.deletedAt = null;
    return this.save();
  };

  schema.statics.deleteOne = function (filter, options) {
    const castFilter = castIdFilter(filter as Record<string, unknown>);
    if (options && options.hardDelete) {
      return this.collection.deleteOne(castFilter);
    }
    // Perform a soft delete by updating the `deletedAt` field.
    // Use raw MongoDB driver to bypass Mongoose 8's stricter path inference,
    // which throws "path 'userId' is matched twice" when CASL generates $or
    // filters containing both root userId and nested users.userId paths.
    const softDeleteFilter = { ...castFilter, deletedAt: null };
    console.debug(`Soft deleting one document with filter: ${JSON.stringify(softDeleteFilter)}`);
    return this.collection
      .updateOne(softDeleteFilter, { $set: { deletedAt: new Date() } }, options)
      .then((result: any) => ({
        ...result,
        deletedCount: result.modifiedCount,
      }));
  };

  schema.statics.deleteMany = function (filter, options) {
    const castFilter = castIdFilter(filter as Record<string, unknown>);
    if (options && options.hardDelete) {
      return this.collection.deleteMany(castFilter);
    }
    // Perform a soft delete by updating the `deletedAt` field.
    // Use raw MongoDB driver to bypass Mongoose 8's path inference (see deleteOne above).
    const softDeleteFilter = { ...castFilter, deletedAt: null };
    console.debug(`Soft deleting many documents with filter: ${JSON.stringify(softDeleteFilter)}`);
    return this.collection
      .updateMany(softDeleteFilter, { $set: { deletedAt: new Date() } }, options)
      .then((result: any) => ({
        ...result,
        deletedCount: result.modifiedCount,
      }));
  };

  // Filter out soft-deleted documents by default; callers opt in via includeDeleted.
  schema.pre('find', function (next) {
    if (!this.getOptions().includeDeleted) {
      this.where({ deletedAt: null });
    }
    next();
  });

  schema.pre('findOne', function (next) {
    if (!this.getOptions().includeDeleted) {
      this.where({ deletedAt: null });
    }
    next();
  });

  // Document-level middleware for deleteOne/deleteMany
  schema.pre(['deleteOne', 'deleteMany'], { document: true, query: false }, async function (next) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Mongoose middleware 'this' type is dynamic
    if ((this as any).getOptions?.().hardDelete) {
      return next();
    }
    await this.softDelete();
  });

  schema.pre(['findOneAndDelete'], { document: false, query: true }, async function (next) {
    if (this.getOptions().hardDelete) {
      return next();
    }
    // Auto-convert findOneAndDelete to soft delete instead of throwing
    // This is safer than throwing as it prevents accidental data loss
    const filter = this.getFilter();
    const queryOptions = this.getOptions();
    const castFilter = castIdFilter(filter as Record<string, unknown>);
    const softDeleteFilter = { ...castFilter, deletedAt: null };
    await this.model.collection.updateOne(
      softDeleteFilter,
      { $set: { deletedAt: new Date() } },
      queryOptions.session ? { session: queryOptions.session } : {}
    );
    // Skip the original delete operation by returning a null result
    // This means the operation won't return the deleted document
    // If you need the document, use findOneAndUpdate with { $set: { deletedAt: new Date() } } directly
    this.setQuery({ _id: null }); // Set impossible filter to prevent actual deletion
    return next();
  });

  schema.index({ deletedAt: 1 }, { sparse: true, background: false });
};

/**
 * Convert string-form IDs to ObjectId automatically.
 */
export function convertId(id: string | mongoose.Types.ObjectId): mongoose.Types.ObjectId {
  return typeof id === 'string' ? new mongoose.Types.ObjectId(id) : id;
}

/**
 * Convert an array of string-form IDs to ObjectId automatically.
 */
export function convertIds(ids: Array<string | mongoose.Types.ObjectId>): Array<mongoose.Types.ObjectId> {
  return ids.map(convertId);
}

/**
 * Compare two IDs, converting them to ObjectId if necessary.
 */
export function compareMongoIds(a: string | mongoose.Types.ObjectId, b: string | mongoose.Types.ObjectId) {
  return convertId(a).equals(convertId(b));
}

export async function safeDropIndex(collection: mongoose.Collection, indexName: string) {
  try {
    await collection.dropIndex(indexName);
    console.log(`✓ Dropped index: ${indexName}`);
  } catch (error) {
    if (error instanceof mongoose.mongo.MongoError && error.code === 27) {
      console.log(`⚠ Index not found (skipping): ${indexName}`);
    } else if (error instanceof Error && error.message?.includes('index not found')) {
      console.log(`⚠ Index not found (skipping): ${indexName}`);
    } else {
      throw error;
    }
  }
}
