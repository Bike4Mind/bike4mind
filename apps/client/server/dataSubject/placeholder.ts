import { mongoose } from '@bike4mind/database';

/**
 * What an anonymized reference to an erased person becomes. Fixed values rather than an unset, since
 * many anonymized paths are `required` and the document must still validate on its next save.
 */
export const DELETED_USER_ID = '0'.repeat(24);
export const DELETED_USER_OBJECT_ID = new mongoose.Types.ObjectId(DELETED_USER_ID);
export const DELETED_USER_EMAIL = 'deleted-user@deleted.invalid';
export const DELETED_USER_NAME = 'Deleted user';

/** The placeholder in the stored form of `value`, so an ObjectId path keeps holding an ObjectId. */
export function deletedUserValue(value: unknown, matchBy: 'userId' | 'email'): unknown {
  if (matchBy === 'email') return DELETED_USER_EMAIL;
  // The driver's class: a lean read decodes ObjectIds without Mongoose's subclass.
  return value instanceof mongoose.mongo.ObjectId ? DELETED_USER_OBJECT_ID : DELETED_USER_ID;
}
