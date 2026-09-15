import { isEqual } from 'lodash';
import type { IUserDocument } from '@bike4mind/common';
import type { AdminUserListItem } from '@client/app/utils/adminUserProjection';
import type { EditedFieldsState } from '@client/app/components/admin/Users/Views/FullUsersView';

/**
 * Whether a staged value still matches what the server gave us. `null` and
 * `undefined` both mean "unset" on these fields, so they compare equal - otherwise
 * clearing a field that was never set would read as an edit.
 *
 * Known conservative case: the subscription date input hands back a 'YYYY-MM-DD'
 * string while the server sends a full timestamp, so retyping the original date
 * still reads as edited. Over-reporting is the safe direction here.
 */
const matchesSavedValue = (staged: unknown, saved: unknown): boolean =>
  (staged == null && saved == null) || isEqual(staged, saved);

/**
 * Records a field edit as "differs from what is saved" rather than "was touched".
 * Typing into a field and undoing it, or adding a tag and removing it again, leaves
 * nothing to save - so it must not light up the card or warn on the way out.
 */
export const stageFieldEdit = (
  editedFields: EditedFieldsState,
  key: keyof IUserDocument,
  value: unknown,
  savedUser: AdminUserListItem
): EditedFieldsState => ({
  ...editedFields,
  // savedUser is the list projection, which is narrower than the fields admins edit
  // (e.g. emailVerifiedAt), so index it structurally.
  [key]: !matchesSavedValue(value, (savedUser as Record<string, unknown>)[key]),
});
