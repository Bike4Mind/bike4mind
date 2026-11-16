import { createHash } from 'crypto';
import { mongoose } from '@bike4mind/database';

/**
 * What an anonymized reference to an erased person becomes. Fixed values rather than an unset, since
 * many anonymized paths are `required` and the document must still validate on its next save.
 */
export const DELETED_USER_ID = '0'.repeat(24);
export const DELETED_USER_OBJECT_ID = new mongoose.Types.ObjectId(DELETED_USER_ID);
export const DELETED_USER_EMAIL = 'deleted-user@deleted.invalid';
export const DELETED_USER_NAME = 'Deleted user';
export const REDACTED_IP = '0.0.0.0';
export const REDACTED_VALUE = 'redacted';

/**
 * The placeholder in the stored form of `value`, so an ObjectId path keeps holding an ObjectId.
 * With `rowId` it is distinct per row, for a path in a unique index that one shared placeholder
 * would collide on at the second erasure. Its zero timestamp keeps it apart from any real ObjectId.
 */
export function deletedUserValue(value: unknown, matchBy: 'userId' | 'email', rowId?: unknown): unknown {
  const suffix = rowId === undefined ? null : createHash('sha256').update(String(rowId)).digest('hex').slice(0, 16);
  if (matchBy === 'email') return suffix ? `deleted-user-${suffix}@deleted.invalid` : DELETED_USER_EMAIL;
  const id = suffix ? `${'0'.repeat(8)}${suffix}` : DELETED_USER_ID;
  // The driver's class: a lean read decodes ObjectIds without Mongoose's subclass.
  return value instanceof mongoose.mongo.ObjectId ? new mongoose.Types.ObjectId(id) : id;
}

/** A required `alsoRedact` field keeps a value of its own kind rather than a name in an IP column. */
export function redactedValue(path: string, instance: string): unknown {
  if (instance === 'ObjectId') return DELETED_USER_OBJECT_ID;
  const leaf = path.split('.').pop() ?? path;
  // camelCase word boundaries, so `membership` is not an IP and `rename` is not a name.
  if (/(^ip|Ip|IP)(Address)?$/.test(leaf)) return REDACTED_IP;
  if (/(^name|Name)$/.test(leaf)) return DELETED_USER_NAME;
  return REDACTED_VALUE;
}

/** Paths that are a key of some unique index of `schema`, field-level `unique` included. */
export function uniqueIndexPaths(schema: mongoose.Schema): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const [fields, options] of schema.indexes()) {
    if (options?.unique) Object.keys(fields).forEach(path => paths.add(path));
  }
  schema.eachPath((path, type) => {
    if ((type.options as { unique?: boolean } | undefined)?.unique) paths.add(path);
  });
  return paths;
}
