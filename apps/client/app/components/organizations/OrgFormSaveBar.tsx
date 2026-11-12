import { SaveBar, UnsavedChangesGuard } from '@client/app/components/admin/shared';
import type { FC } from 'react';

/** Key-by-key, so the same params in a different order do not read as leaving. */
const sameSearch = (a: object, b: object): boolean => {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].every(key => left[key] === right[key]);
};

/**
 * The one save model for every form on the organization page: staged edits, a sticky bar with the
 * unsaved count, Discard and Save, and a guard against leaving with edits. Single toggles that
 * apply immediately do not use it. Each tab or Integrations section shows one form at a time, so
 * the page never stacks two of these.
 */
const OrgFormSaveBar: FC<{
  count: number;
  pending?: boolean;
  blockedReason?: string;
  onSave(): void;
  onDiscard(): void;
}> = ({ count, pending, blockedReason, onSave, onDiscard }) => (
  <>
    <SaveBar count={count} pending={pending} blockedReason={blockedReason} onSave={onSave} onDiscard={onDiscard} />
    <UnsavedChangesGuard
      dirty={count > 0}
      pending={pending}
      // Switching tab or Integrations section unmounts the form too, so any URL change is leaving.
      isLeaving={(current, next) => current.pathname !== next.pathname || !sameSearch(current.search, next.search)}
    />
  </>
);

export default OrgFormSaveBar;
