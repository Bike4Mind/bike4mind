import type { IUserDocument } from '@bike4mind/common';
import type { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';

/**
 * Human labels for the admin-editable fields on the user card, in the order they
 * are listed back to the admin. Must stay in sync with the `onFieldChange` keys
 * the card's sections emit (UserDetails, UserPermissions, ProductAccess,
 * Bike4MindUserDetails, SpicyUserActions); an unmapped key still shows,
 * prettified from its name. Several keys deliberately share a label (they always
 * move together, and the admin thinks of them as one thing) - duplicates are
 * collapsed.
 */
const FIELD_LABELS: Partial<Record<keyof IUserDocument, string>> = {
  name: 'Name',
  username: 'Username',
  email: 'Email',
  emailVerified: 'Email verification',
  emailVerifiedAt: 'Email verification',
  level: 'User level',
  isAdmin: 'Role',
  tags: 'Tags and product access',
  currentCredits: 'Credits',
  storageLimit: 'Storage limit',
  numReferralsAvailable: 'Referrals available',
  subscribedUntil: 'Subscribed until',
  isBanned: 'Banned',
  isModerated: 'Moderated',
};

const prettifyKey = (key: string): string =>
  key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, char => char.toUpperCase())
    .trim();

/** The field keys the card has staged but not yet sent to the server. */
export const unsavedFieldKeys = (editedFields: EditedFieldsState): string[] =>
  Object.entries(editedFields)
    .filter(([, isEdited]) => isEdited)
    .map(([key]) => key);

/** The distinct labels behind those keys, for "you have not saved X yet". */
export const unsavedFieldLabels = (keys: readonly string[]): string[] => {
  const known = Object.keys(FIELD_LABELS).filter(key => keys.includes(key));
  const unknown = keys.filter(key => !(key in FIELD_LABELS));
  const labels = [...known.map(key => FIELD_LABELS[key as keyof IUserDocument] as string), ...unknown.map(prettifyKey)];
  return Array.from(new Set(labels));
};
