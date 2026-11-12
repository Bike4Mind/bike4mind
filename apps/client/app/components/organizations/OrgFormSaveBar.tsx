import { SaveBar, UnsavedChangesGuard } from '@client/app/components/admin/shared';
import type { FC } from 'react';

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
      isLeaving={(current, next) =>
        current.pathname !== next.pathname || JSON.stringify(current.search) !== JSON.stringify(next.search)
      }
    />
  </>
);

export default OrgFormSaveBar;
